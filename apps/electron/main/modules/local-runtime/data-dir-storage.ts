import { execFile } from "node:child_process";
import * as path from "node:path";
import { dataDirFs } from "./data-dir-fs.js";
export class DataDirStorageError extends Error {
    constructor(code, detail) {
        super(detail ? `${code}: ${detail}` : code);
        this.code = code;
    }
}

// Cold Storage/PnP providers can exceed 20s on otherwise valid internal disks.
const STORAGE_TIMEOUT_MS = 60000;
// Sync clients lock, replace or dehydrate files behind the Runtime's back, which breaks
// SQLite and atomic renames even though the folder sits on an internal disk. Only proof
// that a client owns the folder rejects it: a root registered with the Windows Cloud Files
// API (checked by the helper below) or a root OneDrive publishes in the environment.
// Folder names alone are only a hint: an ordinary folder can be called "Dropbox" or
// "华为云盘", so callers must let the user confirm instead of rejecting on a name match.
const CLOUD_SYNC_FOLDER_NAMES = new Set([
    'OneDrive',
    'Dropbox',
    'iCloudDrive',
    'iCloud Drive',
    'Google Drive',
    'Box Sync',
    'Nutstore',
    '坚果云',
    '我的坚果云',
    'BaiduSyncdisk',
    '百度网盘同步空间',
    '华为云盘',
    '阿里云盘',
    'WPS云盘',
    'SynologyDrive',
    'Synology Drive',
].map((name) => name.toLowerCase()));
// Business accounts append the tenant name, e.g. "OneDrive - Contoso" / "Dropbox (Contoso)".
const CLOUD_SYNC_FOLDER_PREFIXES = ['onedrive - ', 'dropbox ('];
const ONEDRIVE_ENV_KEYS = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'];
function windowsPathSegments(directory) {
    return path.win32
        .normalize(directory)
        .split('\\')
        .filter(Boolean)
        .map((segment) => segment.toLowerCase());
}
/** A path segment is named like a common sync client root. Not proof of syncing. */
export function looksLikeCloudSyncedPath(directory) {
    return windowsPathSegments(directory).some((segment) => CLOUD_SYNC_FOLDER_NAMES.has(segment) ||
        CLOUD_SYNC_FOLDER_PREFIXES.some((prefix) => segment.startsWith(prefix)));
}
/** The path is inside a root that OneDrive publishes (possibly renamed) through the environment. */
export function isInsideOneDriveRoot(directory, env = process.env) {
    const segments = windowsPathSegments(directory);
    return ONEDRIVE_ENV_KEYS.some((key) => {
        const root = env[key]?.trim();
        if (!root || !path.win32.isAbsolute(root))
            return false;
        const rootSegments = windowsPathSegments(root);
        return (rootSegments.length > 0 &&
            rootSegments.length <= segments.length &&
            rootSegments.every((segment, index) => segment === segments[index]));
    });
}
// Query the containing volume, not the drive letter: a directory can be a mounted volume.
// PnP ancestors are checked as well because an external PCIe/NVMe enclosure can report NVMe.
const STORAGE_SCRIPT = String.raw `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::Error.WriteLine('[DataDirStorage] stage=sync-root')
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DataDirVolume {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetVolumePathName(string path, StringBuilder volume, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetVolumeNameForVolumeMountPoint(string path, StringBuilder name, uint size);
  [DllImport("cldapi.dll", CharSet=CharSet.Unicode)]
  static extern int CfGetSyncRootInfoByPath(string path, int infoClass, [Out] byte[] info, uint length, out uint returned);
  public static string Resolve(string path) {
    var mount = new StringBuilder(32768);
    var name = new StringBuilder(1024);
    if (!GetVolumePathName(path, mount, (uint)mount.Capacity) ||
        !GetVolumeNameForVolumeMountPoint(mount.ToString(), name, (uint)name.Capacity))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return name.ToString();
  }
  // S_OK or ERROR_MORE_DATA: the path is inside a registered Cloud Files sync root.
  // ERROR_CLOUD_FILE_NOT_UNDER_SYNC_ROOT and an absent API (pre-1709) are not sync roots.
  public static bool IsUnderSyncRoot(string path) {
    var info = new byte[8];
    uint returned;
    try {
      int hr = CfGetSyncRootInfoByPath(path, 0, info, (uint)info.Length, out returned);
      return hr == 0 || hr == unchecked((int)0x800700EA);
    } catch (DllNotFoundException) {
      return false;
    } catch (EntryPointNotFoundException) {
      return false;
    }
  }
}
'@
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__TARGET_BASE64__'))
$cloudSyncRoot = [DataDirVolume]::IsUnderSyncRoot($target)
[Console]::Error.WriteLine('[DataDirStorage] stage=volume')
$volumes = @(Get-Volume -Path ([DataDirVolume]::Resolve($target)))
if ($volumes.Count -ne 1) { throw 'Ambiguous volume' }
$volume = $volumes[0]
[Console]::Error.WriteLine('[DataDirStorage] stage=disk')
$disks = @($volume | Get-Partition | Get-Disk)
if ($disks.Count -ne 1) { throw 'Ambiguous physical disk' }
$disk = $disks[0]
[Console]::Error.WriteLine('[DataDirStorage] stage=device')
$devices = @(Get-CimInstance Win32_DiskDrive -Filter ('Index = ' + [uint32]$disk.Number))
if ($devices.Count -ne 1) { throw 'Missing physical device' }
$deviceId = $devices[0].PNPDeviceID
if ([string]::IsNullOrWhiteSpace($deviceId)) { throw 'Missing PnP identity' }
$policies = @()
$capabilities = @()
$seen = @{}
[Console]::Error.WriteLine('[DataDirStorage] stage=pnp')
while ($deviceId -ne 'HTREE\ROOT\0') {
  if ($seen.ContainsKey($deviceId) -or $seen.Count -ge 32) { throw 'Invalid PnP ancestry' }
  $seen[$deviceId] = $true
  # Each cmdlet invocation is costly; query all three properties in one provider call.
  $properties = @(Get-PnpDeviceProperty -InstanceId $deviceId -KeyName 'DEVPKEY_Device_RemovalPolicy','DEVPKEY_Device_Capabilities','DEVPKEY_Device_Parent')
  $policy = @($properties | Where-Object KeyName -eq 'DEVPKEY_Device_RemovalPolicy')
  $caps = @($properties | Where-Object KeyName -eq 'DEVPKEY_Device_Capabilities')
  $parent = @($properties | Where-Object KeyName -eq 'DEVPKEY_Device_Parent')
  if ($policy.Count -ne 1 -or $caps.Count -ne 1 -or $parent.Count -ne 1 -or
      $null -eq $policy[0].Data -or $null -eq $caps[0].Data -or
      [string]::IsNullOrWhiteSpace($parent[0].Data)) { throw 'Incomplete PnP properties' }
  $policies += [uint32]$policy[0].Data
  $capabilities += [uint32]$caps[0].Data
  $deviceId = [string]$parent[0].Data
}
@{
  cloudSyncRoot = [bool]$cloudSyncRoot
  driveType = [string]$volume.DriveType
  busType = [string]$disk.BusType
  removalPolicies = @($policies)
  capabilities = @($capabilities)
} | ConvertTo-Json -Compress
`;
function readStorageInfo(realDirectory) {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
        return Promise.reject(new DataDirStorageError('TARGET_STORAGE_UNVERIFIED'));
    }
    const script = STORAGE_SCRIPT.replace('__TARGET_BASE64__', Buffer.from(realDirectory, 'utf8').toString('base64'));
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        execFile(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
        ], { windowsHide: true, timeout: STORAGE_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (!error)
                return resolve(stdout);
            // Do not log error.message or raw stderr: they can contain the encoded
            // command, the user's path, and hardware identifiers.
            const stages = [
                ...(stderr ?? '').matchAll(/\[DataDirStorage\] stage=(sync-root|volume|disk|device|pnp)\b/g),
            ];
            const stage = stages.at(-1)?.[1] ?? 'startup';
            const reason = error.killed ? 'timeout' : `failed (code=${error.code ?? 'unknown'})`;
            reject(new DataDirStorageError('TARGET_STORAGE_UNVERIFIED', `storage probe ${reason}; stage=${stage}; elapsedMs=${Date.now() - startedAt}; limitMs=${STORAGE_TIMEOUT_MS}`));
        });
    });
}
export function assertInternalDiskReport(output) {
    let report;
    try {
        report = JSON.parse(output.trim());
    }
    catch {
        throw new DataDirStorageError('TARGET_STORAGE_UNVERIFIED');
    }
    const policies = report?.removalPolicies;
    const capabilities = report?.capabilities;
    if (typeof report?.cloudSyncRoot !== 'boolean' ||
        typeof report?.driveType !== 'string' ||
        typeof report?.busType !== 'string' ||
        !Array.isArray(policies) ||
        !Array.isArray(capabilities) ||
        policies.length === 0 ||
        policies.length !== capabilities.length ||
        ![...policies, ...capabilities].every((value) => Number.isInteger(value) && value >= 0)) {
        throw new DataDirStorageError('TARGET_STORAGE_UNVERIFIED');
    }
    if (report.cloudSyncRoot) {
        throw new DataDirStorageError('TARGET_CLOUD_SYNCED');
    }
    // Unknown, RAID, virtual, USB, SD, iSCSI, etc. are deliberately not an allowlist match.
    // CM_REMOVAL_POLICY_EXPECT_NO_REMOVAL=1; CM_DEVCAP_REMOVABLE=4, DOCKDEVICE=8.
    if (report.driveType !== 'Fixed' ||
        !['ATA', 'SATA', 'NVMe'].includes(report.busType) ||
        policies.some((policy) => policy !== 1) ||
        capabilities.some((caps) => (caps & 12) !== 0)) {
        throw new DataDirStorageError('TARGET_NOT_INTERNAL_DISK');
    }
}
export async function assertInternalDataDirStorage(realDirectory) {
    // realpath may return an extended-length local path, which is distinct from UNC.
    const directory = realDirectory.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
    if (!/^[a-z]:\\/i.test(directory)) {
        throw new DataDirStorageError('TARGET_NOT_INTERNAL_DISK');
    }
    if (isInsideOneDriveRoot(directory)) {
        throw new DataDirStorageError('TARGET_CLOUD_SYNCED');
    }
    try {
        assertInternalDiskReport(await readStorageInfo(directory));
    }
    catch (error) {
        if (error instanceof DataDirStorageError)
            throw error;
        throw new DataDirStorageError('TARGET_STORAGE_UNVERIFIED');
    }
}
export async function probeDataDirWrites(parentDir) {
    const probe = await dataDirFs.mkdtemp(path.join(parentDir, '.minimax-storage-probe-'));
    try {
        const source = path.join(probe, 'source');
        const target = path.join(probe, 'target');
        await dataDirFs.writeFile(source, 'minimax-storage-probe', { flag: 'wx' });
        await dataDirFs.writeFile(target, 'replace-me', { flag: 'wx' });
        await dataDirFs.rename(source, target);
        if ((await dataDirFs.readFile(target, 'utf8')) !== 'minimax-storage-probe') {
            throw new Error('Data directory readback failed');
        }
        await dataDirFs.unlink(target);
    }
    finally {
        await dataDirFs.rm(probe, { recursive: true, force: true });
    }
}

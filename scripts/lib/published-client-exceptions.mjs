// Strings under `apps/electron/**` that are exempt from the internal-source
// pattern in `check:source`, declared once and reviewed individually.
//
// Rationale: the desktop client is distributed publicly, and the recovered
// tree is byte-identical to what that public installation ships. The entries
// below are inert strings that the shipped artifacts legitimately embed:
//
// - `*.xaminim.com` hosts: test/pre environment endpoints that the shipped
//   binaries, bundles and test-install helpers carry; they are dormant in the
//   production lanes.
// - `/Users/minimax/`: absolute build-machine paths embedded in prebuilt
//   artifacts (wasm assemblies, minified bundles) that cannot be rewritten
//   without changing the shipped bytes.
// - the first-party thrift-generated package names (`@mavis` scope) and the Go
//   module path of the shipped thrift AST helper. The desktop runtime requires
//   these packages by name.
//
// Every entry is (file, exact matched string). A new string in a listed file
// still fails the check; nothing else is exempted.
export const publishedClientExceptions = {
  "apps/electron/main/config/constants.ts":
    ["matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com", "mmx-pre.xaminim.com", "mmx-test.xaminim.com", "open-platform-for-online-test.xaminim.com", "openplatform-test.xaminim.com"],
  "apps/electron/main/ipc/storage.ipc.ts":
    ["mmx-pre.xaminim.com", "mmx-test.xaminim.com", "open-platform-for-online-test.xaminim.com", "openplatform-test.xaminim.com"],
  "apps/electron/main/modules/cors/index.ts":
    ["account-overseas-pre.xaminim.com", "account-overseas-test.xaminim.com", "account-pre.xaminim.com", "account-test.xaminim.com", "chat-pre.xaminim.com", "hiloai-test.xaminim.com", "matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com"],
  "apps/electron/main/modules/deeplink/index.ts":
    ["matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com"],
  "apps/electron/main/modules/oss/index.ts":
    ["matrix-overseas-test.xaminim.com", "matrix-test.xaminim.com"],
  "apps/electron/main/modules/remote-control-bridge/ipc.ts": ["@mavis/thrift-gen"],
  "apps/electron/main/modules/ssh-runtime/cli-install-target.ts": ["npmmirror.xaminim.com"],
  "apps/electron/main/modules/ssh-runtime/shared-global-events.ts": ["@mavis/thrift-gen"],
  "apps/electron/out/_next/static/chunks/41412-1218a6cf54a78020.js":
    ["matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com", "platform-pay-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/51656.aa39f6bad8ce3c84.js":
    ["lark-auth-vela-bench.xaminim.com", "platform-api.xaminim.com"],
  "apps/electron/out/_next/static/chunks/53243.0883e42862b425b0.js":
    ["account-overseas-pre.xaminim.com", "account-overseas-test.xaminim.com", "account-pre.xaminim.com", "account-test.xaminim.com", "matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com", "mmx-pre.xaminim.com", "mmx-test.xaminim.com", "open-platform-for-online-test.xaminim.com", "openplatform-test.xaminim.com", "platform-pre.xaminim.com", "platform-test.xaminim.com", "platform-us-pre.xaminim.com", "platform-us-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/64741-93599618c13a4408.js":
    ["account-overseas-pre.xaminim.com", "account-overseas-test.xaminim.com", "account-pre.xaminim.com", "account-test.xaminim.com", "matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com", "mmx-pre.xaminim.com", "mmx-test.xaminim.com", "open-platform-for-online-test.xaminim.com", "openplatform-test.xaminim.com", "platform-pre.xaminim.com", "platform-test.xaminim.com", "platform-us-pre.xaminim.com", "platform-us-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/68097.9eb14108b56ef21a.js":
    ["matrix-overseas-test.xaminim.com", "matrix-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/69200.38fd465b9831d0d4.js":
    ["account-pre.xaminim.com", "account-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/70323.ac6517e92179a16f.js": ["/Users/minimax/"],
  "apps/electron/out/_next/static/chunks/93882.e316df98134d5ffe.js": ["/Users/minimax/"],
  "apps/electron/out/_next/static/chunks/aad4249a.51c068675f46421b.js": ["/Users/minimax/"],
  "apps/electron/out/_next/static/chunks/app/(pages)/login/page-9d6fe2fd7fbde9e2.js":
    ["account-pre.xaminim.com", "account-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/app/error-9fb08eac2be6dc9c.js":
    ["account-overseas-pre.xaminim.com", "account-overseas-test.xaminim.com", "account-pre.xaminim.com", "account-test.xaminim.com", "matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com", "mmx-pre.xaminim.com", "mmx-test.xaminim.com", "open-platform-for-online-test.xaminim.com", "openplatform-test.xaminim.com", "platform-pre.xaminim.com", "platform-test.xaminim.com", "platform-us-pre.xaminim.com", "platform-us-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/pptx-media-decoder.6797f81c64877811.js":
    ["/Users/minimax/"],
  "apps/electron/package.json": ["@mavis/thrift-gen"],
  "apps/electron/pnpm-lock.yaml": ["@mavis/thrift-gen"],
  "apps/electron/resources/install-mcode-test.sh": ["npmmirror.xaminim.com"],
  "apps/electron/resources/mcode-tools/cli.mjs":
    ["account-overseas-pre.xaminim.com", "account-overseas-test.xaminim.com", "account-pre.xaminim.com", "account-test.xaminim.com", "matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com"],
  "apps/electron/resources/pptx-core/9683f0a97cc01509a49303542d5e17c3aaf9256f3e81ab7d4bb322af9705303a/_framework/Mavis.Pptx.Importer.Wasm.2f1rp4czkl.wasm":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/9683f0a97cc01509a49303542d5e17c3aaf9256f3e81ab7d4bb322af9705303a/_framework/Mavis.Pptx.Importer.Wasm.2f1rp4czkl.wasm.gz":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/9683f0a97cc01509a49303542d5e17c3aaf9256f3e81ab7d4bb322af9705303a/_framework/Mavis.Pptx.Importer.ah7ai85qga.wasm":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/9683f0a97cc01509a49303542d5e17c3aaf9256f3e81ab7d4bb322af9705303a/_framework/Mavis.Pptx.Importer.ah7ai85qga.wasm.gz":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/9683f0a97cc01509a49303542d5e17c3aaf9256f3e81ab7d4bb322af9705303a/_framework/Mavis.Pptx.SafeOpc.o6airvchqz.wasm":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/9683f0a97cc01509a49303542d5e17c3aaf9256f3e81ab7d4bb322af9705303a/_framework/Mavis.Pptx.SafeOpc.o6airvchqz.wasm.gz":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/9683f0a97cc01509a49303542d5e17c3aaf9256f3e81ab7d4bb322af9705303a/_framework/dotnet.native.afikkofx3k.wasm":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/9683f0a97cc01509a49303542d5e17c3aaf9256f3e81ab7d4bb322af9705303a/_framework/dotnet.native.afikkofx3k.wasm.gz":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/9683f0a97cc01509a49303542d5e17c3aaf9256f3e81ab7d4bb322af9705303a/_framework/dotnet.native.q1bp8lh4u4.js":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/9683f0a97cc01509a49303542d5e17c3aaf9256f3e81ab7d4bb322af9705303a/_framework/dotnet.native.q1bp8lh4u4.js.gz":
    ["/Users/minimax/"],
  "apps/electron/resources/session-transfer/win32-x64/mavis-session-transfer-client.exe":
    ["gitlab.xaminim.com"],
  "apps/electron/vendor/@mavis/local-runtime-v2/assets/skills/pdf/templates/data-viz-report/cases/annual-report-financial-digest-latex/build_charts.py":
    ["/Users/minimax/"],
  "apps/electron/vendor/@mavis/local-runtime-v2/package.json": ["@mavis/thrift-gen"],
  "apps/electron/vendor/@mavis/local-runtime/package.json": ["@mavis/thrift-gen"],
  "apps/electron/vendor/@mavis/shared/package.json": ["@mavis/thrift-gen"],
  "apps/electron/vendor/@mavis/thrift-gen-client/package.json": ["@mavis/thrift-gen"],
  "apps/electron/vendor/@mavis/thrift-gen/native/thrift-ast/main.go": ["weaver/idl"],
  "apps/electron/vendor/@mavis/thrift-gen/package.json": ["@mavis/thrift-gen"],
};

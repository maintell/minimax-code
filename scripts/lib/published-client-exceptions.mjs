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
  "apps/electron/out/_next/static/chunks/12252.12b5de81a11c872e.js":
    ["account-pre.xaminim.com", "account-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/16323.d48381483c0d33d5.js":
    ["matrix-overseas-test.xaminim.com", "matrix-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/17454.3ce403b9e30e3172.js": ["/Users/minimax/"],
  "apps/electron/out/_next/static/chunks/51656.aa39f6bad8ce3c84.js":
    ["lark-auth-vela-bench.xaminim.com", "platform-api.xaminim.com"],
  "apps/electron/out/_next/static/chunks/53243.8d6db365926a100d.js":
    ["account-overseas-pre.xaminim.com", "account-overseas-test.xaminim.com", "account-pre.xaminim.com", "account-test.xaminim.com", "matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com", "mmx-pre.xaminim.com", "mmx-test.xaminim.com", "open-platform-for-online-test.xaminim.com", "openplatform-test.xaminim.com", "platform-pre.xaminim.com", "platform-test.xaminim.com", "platform-us-pre.xaminim.com", "platform-us-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/62596-96bed7660a34603f.js":
    ["matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com", "platform-pay-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/64741-cb800a93bb4cbe64.js":
    ["account-overseas-pre.xaminim.com", "account-overseas-test.xaminim.com", "account-pre.xaminim.com", "account-test.xaminim.com", "matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com", "mmx-pre.xaminim.com", "mmx-test.xaminim.com", "open-platform-for-online-test.xaminim.com", "openplatform-test.xaminim.com", "platform-pre.xaminim.com", "platform-test.xaminim.com", "platform-us-pre.xaminim.com", "platform-us-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/70323.ac6517e92179a16f.js": ["/Users/minimax/"],
  "apps/electron/out/_next/static/chunks/aad4249a.51c068675f46421b.js": ["/Users/minimax/"],
  "apps/electron/out/_next/static/chunks/app/(pages)/login/page-ee8f0db959a7d6af.js":
    ["account-pre.xaminim.com", "account-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/app/error-5f194498a5e0bfde.js":
    ["account-overseas-pre.xaminim.com", "account-overseas-test.xaminim.com", "account-pre.xaminim.com", "account-test.xaminim.com", "matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com", "mmx-pre.xaminim.com", "mmx-test.xaminim.com", "open-platform-for-online-test.xaminim.com", "openplatform-test.xaminim.com", "platform-pre.xaminim.com", "platform-test.xaminim.com", "platform-us-pre.xaminim.com", "platform-us-test.xaminim.com"],
  "apps/electron/out/_next/static/chunks/pptx-media-decoder.6797f81c64877811.js":
    ["/Users/minimax/"],
  "apps/electron/package.json": ["@mavis/thrift-gen"],
  "apps/electron/pnpm-lock.yaml": ["@mavis/thrift-gen"],
  "apps/electron/resources/install-mcode-test.sh": ["npmmirror.xaminim.com"],
  "apps/electron/resources/mcode-tools/cli.mjs":
    ["account-overseas-pre.xaminim.com", "account-overseas-test.xaminim.com", "account-pre.xaminim.com", "account-test.xaminim.com", "matrix-overseas-pre.xaminim.com", "matrix-overseas-test.xaminim.com", "matrix-pre.xaminim.com", "matrix-test.xaminim.com"],
  "apps/electron/resources/pptx-core/r/_framework/Mavis.Pptx.Importer.Wasm.1ve8ltf1zs.wasm":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/r/_framework/Mavis.Pptx.Importer.rttnlpy4tr.wasm":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/r/_framework/Mavis.Pptx.SafeOpc.joi4e1d8bm.wasm":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/r/_framework/dotnet.native.afikkofx3k.wasm":
    ["/Users/minimax/"],
  "apps/electron/resources/pptx-core/r/_framework/dotnet.native.q1bp8lh4u4.js": ["/Users/minimax/"],
  "apps/electron/resources/session-transfer/win32-x64/mavis-session-transfer-client.exe":
    ["gitlab.xaminim.com"],
  "apps/electron/vendor/@mavis/local-runtime-v2/assets/skills/pdf/templates/data-viz-report/cases/annual-report-financial-digest-latex/build_charts.py":
    ["/Users/minimax/"],
  "apps/electron/vendor/@mavis/thrift-gen-client/package.json": ["@mavis/thrift-gen"],
  "apps/electron/vendor/@mavis/thrift-gen/native/thrift-ast/main.go": ["weaver/idl"],
  "apps/electron/vendor/@mavis/thrift-gen/package.json": ["@mavis/thrift-gen"],
};

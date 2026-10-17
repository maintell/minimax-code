// Compatibility facade for callers that already imported the desktop-service
// client surface through @mavis/shared. Keep this layer renderer-safe by
// forwarding to @mavis/thrift-gen-client, not the generator/server package.
export { createDesktopServiceClient, } from '@mavis/thrift-gen-client';
//# sourceMappingURL=desktop-service.js.map
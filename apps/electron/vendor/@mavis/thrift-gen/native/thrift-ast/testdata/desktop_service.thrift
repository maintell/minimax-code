namespace js matrix.desktop_service

service DesktopService {
    PingResp Ping(1: PingReq req) (api.post="/minimax-desktop/api/v1/ping")
}

struct PingReq {
    1: required string message
}

struct PingResp {
    1: required string message
}

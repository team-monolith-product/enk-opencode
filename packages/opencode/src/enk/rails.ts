/** 팀 pod 가 hackathon-rails 를 부를 때 쓰는 주소와 팀 토큰. rails 설정이 없는 로컬에서는 undefined. */
export namespace Rails {
  export type Endpoint = { url: string; headers: { Authorization: string } }

  export function endpoint(route: string): Endpoint | undefined {
    const url = process.env["ENK_HACKATHON_RAILS_URL"]
    const token = process.env["ENK_AI_USAGE_TOKEN"]
    if (!url || !token) return
    return { url: url.replace(/\/+$/, "") + route, headers: { Authorization: `token ${token}` } }
  }
}

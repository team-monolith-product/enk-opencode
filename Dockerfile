FROM oven/bun:1.3.11 AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts

ARG OPENCODE_ASSET_BASE
ENV OPENCODE_CHANNEL=latest OPENCODE_VERSION=0.0.0-enk OPENCODE_ASSET_BASE=${OPENCODE_ASSET_BASE}
RUN cd packages/opencode && bun run build --single

FROM scratch AS asset-export
COPY --from=build /app/packages/app/dist /

FROM node:22-slim AS dev

ARG PYTHON_VERSION=3.11.2-1+b1

# bubblewrap: 에이전트 셸을 PID 네임스페이스에 가두는 데 쓴다(Sandbox). 커널/seccomp 가 막으면
# opencode 가 부팅 때 실측해서 백엔드 none 으로 떨어지므로, 설치만 해 두고 판단은 런타임에 맡긴다.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates python3=${PYTHON_VERSION} \
    curl wget procps jq make zip unzip less bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system core.excludesFile /etc/opencode/.gitignore

ARG AGENT_BROWSER_VERSION=0.39.4
# 에이전트용 브라우저 도구(agent-browser). 0.x 라 자주 바뀌므로 버전을 고정한다.
# agent-browser install 은 $HOME/.agent-browser/browsers/chrome-<버전> 에 Chrome for Testing 을 받는다.
# 빌드는 root 라 그대로 두면 /root 아래에 깔려 런타임 사용자(jovyan)가 못 찾는다. HOME 을 /opt 로 돌려
# 설치하고, 버전이 바뀌어도 경로가 같도록 실행파일을 고정 경로로 링크해 넘긴다.
# --with-deps 가 apt 로 시스템 라이브러리를 깔 수 있도록 목록을 먼저 받아 둔다(위 단계에서 지웠다).
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/agent-browser/chrome
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
    && apt-get update \
    && HOME=/opt/agent-browser agent-browser install --with-deps \
    && CHROME=$(find /opt/agent-browser/.agent-browser/browsers -type f -name chrome -perm -u+x | head -n 1) \
    && test -n "${CHROME}" \
    && ln -s "${CHROME}" "${AGENT_BROWSER_EXECUTABLE_PATH}" \
    && chmod -R a+rX /opt/agent-browser \
    && rm -rf /var/lib/apt/lists/* /tmp/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

ARG NB_USER="jovyan"
RUN userdel -r node && useradd -l -m -s /bin/bash -N -u 1000 "${NB_USER}"

# auto: 쓸 수 있는 격리 백엔드가 있으면 에이전트 셸을 그 안에서 돌리고, 없으면 예전처럼 돈다.
# 부팅 로그의 "sandbox backend" 줄로 실제로 걸렸는지 확인할 수 있다.
ENV OPENCODE_CONFIG_DIR=/etc/opencode HOME="/home/${NB_USER}" OPENCODE_SANDBOX=auto
WORKDIR /home/${NB_USER}/project

# 런타임 UID가 빌드 시와 다를 수 있으므로 모두에게 권한을 부여한다.
RUN chmod -R 777 ${HOME}

COPY --from=build /app/packages/opencode/dist/opencode-linux-x64/bin/opencode /usr/local/bin/opencode
COPY docker/entrypoint.sh /usr/local/bin/opencode-entrypoint.sh
RUN chmod 755 /usr/local/bin/opencode-entrypoint.sh
COPY docker/AGENTS.md /etc/opencode/AGENTS.md
COPY docker/.gitignore /etc/opencode/.gitignore
COPY docker/opencode.jsonc /etc/opencode/opencode.jsonc
COPY docker/preview-bridge-plugin.js /etc/opencode/preview-bridge-plugin.js
COPY docker/preview-bridge.js /etc/opencode/preview-bridge.js
COPY docker/image-model-router-plugin.js /etc/opencode/image-model-router-plugin.js
# .agents/skills 는 config 디렉터리(/etc/opencode)의 skills/ 로 들어가야 스킬 스캐너가 잡는다.
COPY docker/.agents/skills /etc/opencode/skills

EXPOSE 8888

# 스포너가 주입한 시크릿을 exec 시점 environ 에서 걷어낸 뒤 opencode 를 exec 한다.
# 이게 없으면 에이전트가 `cat /proc/1/environ` 으로 주입된 토큰을 통째로 읽는다.
ENTRYPOINT ["/usr/local/bin/opencode-entrypoint.sh"]
CMD ["opencode", "web", "--port", "8888", "--hostname", "0.0.0.0"]

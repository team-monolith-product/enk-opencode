FROM oven/bun:1.3.11 AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
# 미리보기 브릿지(자식 스크립트·opencode 플러그인)를 소스에서 다시 빌드해 이미지에 넣는다. docker/ 에 커밋된
# 빌드 결과를 그대로 쓰면, 소스만 고치고 빌드를 잊었을 때 바뀐 내용이 이미지에 안 들어간다.
RUN cd packages/preview-bridge && bun run build:preview-bridge

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
# 에이전트용 브라우저 도구(agent-browser). 에이전트는 MCP 가 아니라 bash 명령으로 쓴다 — MCP 로 붙이면
# 도구 설명이 요청마다 약 17만 자 실린다. 0.x 라 자주 바뀌므로 버전을 고정한다.
# 브라우저는 `agent-browser install` 이 받는 전체 Chrome 대신, 같은 버전의 chrome-headless-shell(창 없이
# 돌리는 용도로만 만든 가벼운 Chrome for Testing 실행파일)을 직접 받는다. 같은 페이지에서 메모리가 약 1/3
# (1,035MB → 332MB)이고, browser-check 동작과 학생 앱이 쓰는 기능(WebGL·오디오·코덱·저장소 등)은 같았다.
# 다른 점: 알림 권한 기본값이 거부, 내장 PDF 뷰어 없음, favicon 을 요청하지 않음, 확장(--extension)·
# --headed 불가. agent-browser 를 올리면 그 버전의 install 이 받는 Chrome 버전으로 아래 버전도 맞춘다.
# Chrome for Testing 은 linux64(amd64) 만 있다. 이 이미지는 opencode-linux-x64 를 쓰므로 amd64 전용이다.
# 시스템 라이브러리는 headless-shell 이 실제로 링크하는 것만 apt 로 깐다(ldd 기준, 빼고 나서 한글·이모지·
# WebGL·스크린샷 확인). install --with-deps 목록에 있던 GTK 등은 GTK 가 systemd·dbus 까지 끌고 와 뺐다.
# fonts-noto-cjk 는 한글 화면 스크린샷이 네모로 깨지지 않게 한다.
#   AGENT_BROWSER_ARGS: 컨테이너 안에서는 Chrome 자체 sandbox 가 서지 않는다.
#   AGENT_BROWSER_IDLE_TIMEOUT_MS: 에이전트가 close 를 빠뜨려도 5분 뒤 데몬과 Chrome 이 내려간다.
# 받은 압축 파일이 바뀌었으면(저장소 쪽 교체·경로 오류) 빌드를 멈추도록 sha256 을 고정한다. 버전을 올리면
# 새 파일의 값으로 같이 바꾼다: curl -fsSL <아래 주소> | sha256sum
ARG CHROME_HEADLESS_SHELL_VERSION=157.0.8103.38
ARG CHROME_HEADLESS_SHELL_SHA256=deafffa74660b34853a4119c361fd427ac8c9fcb62db51ddb8a797cd83a4ba2d
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/agent-browser/chrome-headless-shell \
    AGENT_BROWSER_ARGS=--no-sandbox \
    AGENT_BROWSER_IDLE_TIMEOUT_MS=300000
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       fonts-freefont-ttf fonts-noto-cjk fonts-noto-color-emoji libasound2 libatk-bridge2.0-0 libatk1.0-0 \
       libatspi2.0-0 libdbus-1-3 libdrm2 libgbm1 libnspr4 libnss3 libx11-6 libxcb1 libxcomposite1 \
       libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 \
    && mkdir -p /opt/agent-browser \
    && curl -fsSL -o /tmp/chrome-headless-shell.zip \
       "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_HEADLESS_SHELL_VERSION}/linux64/chrome-headless-shell-linux64.zip" \
    && echo "${CHROME_HEADLESS_SHELL_SHA256}  /tmp/chrome-headless-shell.zip" | sha256sum -c - \
    && unzip -q /tmp/chrome-headless-shell.zip -d /opt/agent-browser \
    && ln -s /opt/agent-browser/chrome-headless-shell-linux64/chrome-headless-shell "${AGENT_BROWSER_EXECUTABLE_PATH}" \
    && test -x "${AGENT_BROWSER_EXECUTABLE_PATH}" \
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
COPY docker/browser-check.sh /usr/local/bin/browser-check
RUN chmod 755 /usr/local/bin/opencode-entrypoint.sh /usr/local/bin/browser-check
COPY docker/AGENTS.md /etc/opencode/AGENTS.md
COPY docker/.gitignore /etc/opencode/.gitignore
COPY docker/opencode.jsonc /etc/opencode/opencode.jsonc
COPY --from=build /app/docker/preview-bridge-plugin.js /etc/opencode/preview-bridge-plugin.js
COPY --from=build /app/docker/preview-bridge.js /etc/opencode/preview-bridge.js
COPY docker/image-model-router-plugin.js /etc/opencode/image-model-router-plugin.js
# .agents/skills 는 config 디렉터리(/etc/opencode)의 skills/ 로 들어가야 스킬 스캐너가 잡는다.
COPY docker/.agents/skills /etc/opencode/skills

EXPOSE 8888

# 스포너가 주입한 시크릿을 exec 시점 environ 에서 걷어낸 뒤 opencode 를 exec 한다.
# 이게 없으면 에이전트가 `cat /proc/1/environ` 으로 주입된 토큰을 통째로 읽는다.
ENTRYPOINT ["/usr/local/bin/opencode-entrypoint.sh"]
CMD ["opencode", "web", "--port", "8888", "--hostname", "0.0.0.0"]

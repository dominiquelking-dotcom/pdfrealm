FROM node:20-bookworm-slim

WORKDIR /app

# deps for pdf-poppler/qpdf + common native builds (fabric/canvas) + psql for optional SQL migrations
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 make g++ pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    poppler-utils qpdf ghostscript \
    postgresql-client \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 8080
CMD ["bash","-lc","./infra/start.sh"]

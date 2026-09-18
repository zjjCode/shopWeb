# shopWeb 启动说明（Docker / 本地）

> 后端 `server` 在启动时会 **fail-fast 强连 MySQL**（`bootstrap()` → `connectPrisma()`），
> 且限流 / BullMQ 队列依赖 **Redis**。因此无论哪种方式，都必须先把 MySQL 8 + Redis 跑起来。
> 前端 `web`（Vite，端口 5173）把 `/api` `/admin` `/internal` `/static` 代理到后端 `http://localhost:3000`。

---

## 前置条件

- 安装 **Docker Desktop**（Windows 用 WSL2 后端），启动后在终端能执行 `docker compose version`。
- 本机已安装 Node ≥ 20（本项目 `node_modules` 已就绪）。
- 端口 `3306` / `6379` / `3000` / `5173` 未被占用。

---

## 方案 A（推荐）：Docker 只跑基础设施，应用本机原生跑

### 1. 启动 MySQL + Redis

```bash
docker compose up -d
docker compose ps        # 等 db / redis 都 healthy（约 10~30s）
```

容器把 `3306` / `6379` 映射到了本机，应用用 `localhost` 即可连。

### 2. 准备后端环境变量

仓库只有 `server/.env.example`，需复制为 `server/.env` 并填值：

```bash
cd server
cp .env.example .env
```

至少改这三项（其余保持 example 默认值即可）：

```dotenv
# 指向 Docker 里的 MySQL（用户/库名与 compose 中一致）
SHOP__DB__URL=mysql://shop:shop_pwd_change_me@localhost:3306/shop_web

# 指向 Docker 里的 Redis
SHOP__REDIS__URL=redis://localhost:6379/0

# JWT 密钥：必须 ≥ 32 位随机串，可用下面命令生成 4 个
```

生成密钥（本机有 openssl）：

```bash
openssl rand -hex 32   # 分别为 ACCESS / REFRESH / ADMIN_ACCESS / ADMIN_REFRESH 各生成一条
```

填到：

```dotenv
SHOP__JWT__ACCESS_SECRET=<上面生成的 64 位 hex>
SHOP__JWT__REFRESH_SECRET=<...>
SHOP__JWT__ADMIN_ACCESS_SECRET=<...>
SHOP__JWT__ADMIN_REFRESH_SECRET=<...>
```

### 3. 初始化数据库（建表 + 种子数据）

```bash
cd server
npm run prisma:generate     # 生成 Prisma Client（首次或改 schema 后必跑）
npm run prisma:deploy       # 等价于 prisma migrate deploy，按迁移文件建表
npm run prisma:seed         # 写入 RBAC / 管理员 / 商品目录等种子数据
```

> 若 `prisma/migrations` 为空或你想直接按 schema 同步，可用 `npx prisma db push` 代替 `prisma:deploy`。

### 4. 启动后端

```bash
cd server
npm run dev                 # nodemon + tsx 热重载，监听 3000
```

验证：`curl http://localhost:3000/health` 应返回 `{ "status": "ok" }`；
`/health/ready` 应返回 `{ "ready": true, "db": true, "redis": true }`。

### 5. 启动前端

```bash
cd web
npm run dev                 # Vite，监听 5173
```

浏览器打开 **http://localhost:5173/** 即可测试。

---

## 方案 B（可选）：全家桶全容器化

把 `server` / `web` 也做成容器。需要两个 Dockerfile 与扩展后的 compose。

### server/Dockerfile

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run prisma:generate && npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
EXPOSE 3000
# 先按迁移建表，再启动；DB 通过 compose depends_on(healthy) 保证就绪
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
```

### web/Dockerfile

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 5173
# 用 vite preview 提供构建产物；如需代理到 server 容器，见下方说明
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "5173"]
```

> 注意：全容器模式下 `web` 容器内的 Vite 代理目标是 `localhost:3000`，需改为 `http://server:3000`。
> 最简做法：把 `web/vite.config.ts` 的代理 `target` 改为读环境变量 `process.env.VITE_API_TARGET ?? 'http://localhost:3000'`，
> 然后在 compose 的 `web` 服务里传 `environment: { VITE_API_TARGET: "http://server:3000" }`（构建时注入）。

### 扩展后的 compose 片段（追加到 docker-compose.yml 的 services 下）

```yaml
  server:
    build: { context: ./server }
    container_name: shopweb-server
    depends_on:
      db:    { condition: service_healthy }
      redis: { condition: service_healthy }
    env_file: ./server/.env
    environment:
      SHOP__SERVER__HOST: "0.0.0.0"
      SHOP__SERVER__PORT: "3000"
      SHOP__DB__URL: "mysql://shop:shop_pwd_change_me@db:3306/shop_web"
      SHOP__REDIS__URL: "redis://redis:6379/0"
      SHOP__CORS__ORIGINS: "http://localhost:5173"
    ports: ["3000:3000"]

  web:
    build: { context: ./web }
    container_name: shopweb-web
    depends_on: [server]
    environment:
      VITE_API_TARGET: "http://server:3000"
    ports: ["5173:5173"]
```

全家桶启动：`docker compose up -d --build`，数据库初始化仍建议先 `docker compose run --rm server npx prisma migrate deploy && docker compose run --rm server npx prisma db seed`。

---

## 常见问题

- **`/health/ready` 返回 503**：db 或 redis 未就绪，等 `docker compose ps` 全 healthy 再试。
- **Windows 端口冲突**：若本机已装过 MySQL/Redis 占用了 3306/6379，改 compose 的端口映射（如 `"3307:3306"`），并同步改 `.env` 里的 URL 端口。
- **Prisma 报 `P1000/P1001`**：`.env` 的 `SHOP__DB__URL` 用户名/密码/库名与 compose 不一致，核对 `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`。
- **种子数据只在非生产执行**：`prisma/seed.ts` 有 `NODE_ENV==='production'` 守卫，本地 `development` 可正常写入。

---

## 关于当前沙箱环境

当前执行环境**没有安装 Docker**，因此上述 Docker 命令无法在此直接运行；这套说明与 `docker-compose.yml` 是给你**本机**使用的。
若你想在**本沙箱内**直接把服务跑起来测试（无需 Docker），可走「本地便携二进制」路线：下载 Windows 版
MySQL 8 + Redis 并本地启动，其余步骤与方案 A 的 2~5 完全一致。需要的话我可以继续按这条路搭建。

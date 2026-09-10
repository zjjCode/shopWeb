# 电商商城系统（shopWeb）

> 技术栈：Vue 3 + Vite ／ Node.js + Express + TypeScript ／ MySQL 8.0 + Prisma ／ Redis + BullMQ
> 详细使用文档见 `docs/09-使用文档.md`（T111 产出），功能说明见 `docs/08-项目功能说明.md`（T112 产出）。

## 一、目录说明

| 目录 | 说明 |
| --- | --- |
| `server/` | 后端服务（Express + TypeScript + Prisma），端口默认 `3000` |
| `web/` | 前端 SPA（Vue 3 + Vite），dev 端口默认 `5173`，`/api` 代理到后端 |
| `docs/` | 设计文档与开发记录（PRD / 架构 / 数据库 / 流程 / 进度 / 流程记录） |

## 二、快速开始（占位，T111 补全）

```bash
# 1. 后端
cd server
cp .env.example .env      # 填写数据库 / Redis / JWT 密钥
npm install
npm run prisma:generate
npm run dev

# 2. 前端
cd web
cp .env.example .env.development
npm install
npm run dev
```

## 三、当前进度

见 `docs/06-开发进度.md`（唯一权威进度源）。

> 本文件在阶段 0（T001）先占位，详细的环境准备、启动运行、常见问题等内容在 T111 补齐。

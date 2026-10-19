# AgentExpress Control Plane — container image
# Build:  docker build -t agentexpress-control-plane .
# Run:    docker run -p 3000:3000 -e AWS_REGION=us-east-1 \
#           -e AWS_ACCESS_KEY_ID=... -e AWS_SECRET_ACCESS_KEY=... -e AWS_SESSION_TOKEN=... \
#           agentexpress-control-plane
# On ECS/EKS, omit the keys and attach a task role with Bedrock permissions instead.

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# BASE_PATH can be baked in at build time if serving behind a path prefix.
ARG BASE_PATH=""
ENV BASE_PATH=${BASE_PATH}
ENV NEXT_PUBLIC_BASE_PATH=${BASE_PATH}
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV AWS_REGION=us-east-1
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json* ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.mjs ./next.config.mjs
EXPOSE 3000
CMD ["npm", "run", "start"]

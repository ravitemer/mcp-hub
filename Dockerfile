# syntax=docker/dockerfile:1

# Build stage
FROM node:18-alpine AS build
WORKDIR /app
# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY . ./
RUN npm run build

# Runtime stage
FROM node:18-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
RUN apk add --no-cache docker-cli

EXPOSE 37373
CMD ["node", "dist/cli.js", "--port", "37373", "--config", "/config/mcp-servers.json"] 
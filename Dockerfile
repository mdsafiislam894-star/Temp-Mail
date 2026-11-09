FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# (old Dockerfile used `npm ci`, which fails because there is no package-lock.json)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "index.js"]

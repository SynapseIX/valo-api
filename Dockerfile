FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/store.json
VOLUME /data
EXPOSE 3000
USER node
CMD ["node","src/server.js"]

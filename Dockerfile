FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3025 DATA_DIR=/app/data
EXPOSE 3025
CMD ["node", "server.mjs"]

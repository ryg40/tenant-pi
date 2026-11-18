# The review server of hosted mode (HUMAN_REVIEW_HOSTED=1): Core review routes under /s/<id>.
# Build from the package directory: docker build -t walkr-review .
# Hosted mode refuses Double, Coinflip, Trainer and Compare. The history page runs in mirror/Dockerfile.
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY LICENSE ./LICENSE
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "src/server-entry.js"]

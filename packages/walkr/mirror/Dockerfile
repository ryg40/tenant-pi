# Build from the package directory: docker build -f mirror/Dockerfile -t walkr-mirror .
# The mirror imports only Node built-in modules, so the image needs no npm install.
FROM node:24-alpine
WORKDIR /app
COPY package.json LICENSE ./
COPY src ./src
COPY mirror ./mirror
USER node
ENV HUMAN_REVIEW_BIND=0.0.0.0 HUMAN_REVIEW_PORT=3000 HUMAN_REVIEW_COMPARE_ROOT=/mirror
EXPOSE 3000
CMD ["node", "mirror/server.js"]

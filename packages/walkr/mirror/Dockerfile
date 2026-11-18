# Build from the package directory: docker build -f mirror/Dockerfile -t walkr-mirror .
# The mirror reads the Double, Coinflip and Trainer records with the stores of src/, which need the npm runtime
# dependencies (parse5 and others), so the image installs them from package-lock.json.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY LICENSE ./
COPY src ./src
COPY mirror ./mirror
USER node
ENV HUMAN_REVIEW_BIND=0.0.0.0 HUMAN_REVIEW_PORT=3000 HUMAN_REVIEW_COMPARE_ROOT=/mirror
EXPOSE 3000
CMD ["node", "mirror/server.js"]

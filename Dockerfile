FROM apify/actor-node:22

COPY package*.json Dockerfile ./

RUN npm install --omit=dev --omit=optional \
    && npm cache clean --force \
    && rm -rf /tmp/*

COPY . ./

ENV APIFY_LOG_LEVEL=INFO

CMD ["npm", "start", "--silent"]

FROM mongo:7
RUN apt-get update \
 && apt-get install -y --no-install-recommends age \
 && rm -rf /var/lib/apt/lists/*
LABEL com.sapiovian.p0-operations="true"

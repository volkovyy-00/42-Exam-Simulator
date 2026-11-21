# grader:pinned sandbox image. Built once with `docker compose --profile build build`,
# never pulled at grade time. Runs one submission per container (DESIGN.md §6.3).
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev binutils coreutils python3-minimal \
 && rm -rf /var/lib/apt/lists/* \
 && cc --version | head -1
COPY runner.sh /runner.sh
RUN chmod 0555 /runner.sh
USER 65534:65534
WORKDIR /work
ENTRYPOINT []
CMD ["/runner.sh"]

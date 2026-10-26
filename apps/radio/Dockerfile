FROM python:3.13-slim
WORKDIR /app
COPY pyproject.toml ./
COPY skywave_radio ./skywave_radio
RUN pip install --no-cache-dir .
RUN useradd --system --no-create-home radio
USER radio
EXPOSE 8765
# --timeout-graceful-shutdown: on a stop, uvicorn closes every listener's
# socket at once (code 1012) and gives their teardowns, mostly closing their
# Kiwis, up to 15 s; then it cancels the rest and the app waits up to 10 s
# more in total (SHUTDOWN_CLEANUP_TIMEOUT_S) for those Kiwis to close, plus
# about 9 s for any teardown still running at exit (uncapped: a task that
# ignores its cancels holds the exit until the container is killed). Keep the container's stop
# period above all of it (docker-compose.yml: stop_grace_period).
CMD ["uvicorn", "skywave_radio.server:app", "--host", "0.0.0.0", "--port", "8765", "--proxy-headers", "--timeout-graceful-shutdown", "15"]

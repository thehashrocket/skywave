FROM python:3.13-slim
WORKDIR /app
COPY pyproject.toml ./
COPY skywave_radio ./skywave_radio
RUN pip install --no-cache-dir .
RUN useradd --system --no-create-home radio
USER radio
EXPOSE 8765
CMD ["uvicorn", "skywave_radio.server:app", "--host", "0.0.0.0", "--port", "8765", "--proxy-headers"]

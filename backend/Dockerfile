FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY constraints.txt ./
COPY src ./src
RUN pip install --no-cache-dir -c constraints.txt . && useradd --uid 10001 --create-home coach
USER coach
ENV PYTHONUNBUFFERED=1 PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn money_coach.api:app --host 0.0.0.0 --port ${PORT:-8080}"]

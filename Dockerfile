FROM public.ecr.aws/docker/library/python:3.9
RUN apt-get update \
    && pip install --upgrade pip \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 80
COPY src src
COPY requirements.txt .
RUN pip3 install -r requirements.txt
WORKDIR /src
CMD streamlit run app.py \
    --server.headless true \
    --server.port 80
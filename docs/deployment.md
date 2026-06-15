# Deployment

## Local Docker

```bash
cp .env.example .env
npm run docker:up
```

Services:

- Frontend: `http://localhost:4200`
- Backend: `http://localhost:3000/api/v1`
- Swagger: `http://localhost:3000/docs`
- Metrics: `http://localhost:3000/metrics`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001`

## Kubernetes

```bash
kubectl apply -f infra/k8s/namespace.yaml
kubectl apply -f infra/k8s/secret.example.yaml
kubectl apply -f infra/k8s/configmap.yaml
kubectl apply -f infra/k8s/backend.yaml
kubectl apply -f infra/k8s/frontend.yaml
kubectl apply -f infra/k8s/hpa.yaml
kubectl apply -f infra/k8s/ingress.yaml
```

Before production:

- Replace `secret.example.yaml` with real secrets.
- Use managed MongoDB and Redis or deploy replicated operators.
- Configure sticky Socket.IO routing.
- Allocate UDP media port ranges per pod.
- Deploy Coturn with public IPs and TLS certificates.
- Install a production DTLS-SRTP transport adapter.

## Observability

Prometheus scrapes backend `/metrics`. Grafana provisions a starter dashboard with room, participant, RTP forwarding, and packet drop panels.

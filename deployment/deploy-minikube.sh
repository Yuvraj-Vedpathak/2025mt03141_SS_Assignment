#!/usr/bin/env bash
# FoodExpress - one-shot Minikube deployment (Order Service + Payment Service)
# 2025MT03141 / Yuvraj Vijay Vedpathak
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NS=foodexpress

step() { echo; echo "==> $*"; }

step "Starting minikube (skip if already running)"
minikube status >/dev/null 2>&1 || minikube start --driver=docker --cpus=2 --memory=4096

step "Enabling addons: dashboard, metrics-server (for HPA)"
minikube addons enable metrics-server
minikube addons enable dashboard

step "Building images inside minikube (works with docker or containerd runtime)"
minikube image build -t payment-service:1.0 "$ROOT/payment-service"
minikube image build -t order-service:1.0 "$ROOT/order-service"
minikube image ls | grep -E 'payment-service|order-service'

step "Applying Kubernetes manifests"
kubectl apply -f "$ROOT/deployment/k8s/00-namespace.yaml"
kubectl apply -f "$ROOT/payment-service/k8s/"
kubectl apply -f "$ROOT/order-service/k8s/"

step "Waiting for rollouts"
for d in payment-db order-db payment-service order-service; do
  kubectl -n "$NS" rollout status deployment/"$d" --timeout=180s
done

step "Cluster state"
kubectl -n "$NS" get deployments,pods,svc,hpa -o wide

IP="$(minikube ip)"
echo
echo "Order Service   : http://$IP:30002/api/orders"
echo "Payment Service : http://$IP:30003/api/payments"
echo "(If the minikube IP isn't reachable from your host, e.g. Docker Desktop on macOS/Windows, run:"
echo "   minikube service order-service payment-service -n $NS --url )"
echo
echo "Open dashboard  : minikube dashboard"

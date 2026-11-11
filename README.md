# 2025MT03141_FoodExpress
**2025MT03141 / Yuvraj Vijay Vedpathak — Scalable Services Assignment**

FoodExpress is a microservices-based online food ordering application. Two services are implemented:

* `order-service/`: its own repository (Node.js + PostgreSQL). It places and tracks orders, and calls `payment-service` over REST to authorize, capture and refund payments.
* `payment-service/`: its own repository (Node.js + PostgreSQL). It owns payments, the payment ledger and the (simulated) payment gateway.

The final report in the BITS assignment format (cover page, Index, Assignment Details, Requirement, Contribution Table, Answer) is `docs/2025MT03141_SS_Assignment1.docx`, built with `python3 docs/build-docx-bits.py`. The same content is also in `docs/2025MT03141_Yuvraj_Vijay_Vedpathak_FoodExpress_Documentation.docx` (plus `.md` and `.html`).

## Quick start (Minikube)
```bash
./deployment/deploy-minikube.sh     # start minikube, build images, deploy, wait
./deployment/smoke-test.sh          # end-to-end calls
python3 deployment/foodexpress_client.py --order-url http://$(minikube ip):30002 \        --payment-url http://$(minikube ip):30003 demo   # 21 PASS/FAIL checks
minikube dashboard                  # analyse deployments
```
Import `postman/*.postman_collection.json` into Postman, then set `orderUrl` and `paymentUrl` to `http://$(minikube ip):30002` and `:30003`.

## Submission checklist
1. Run the deployment and capture the screenshots listed in `screenshots/README.md` into `screenshots/`, using exactly those filenames.
2. Record the demo following `video/README.md`, and save it as `video/2025MT03141_Yuvraj_Vijay_Vedpathak_FoodExpress_Demo.mp4`.
3. `cd docs && npm i --no-save marked@4 && node build-doc.js && python3 build-docx.py && python3 build-docx-bits.py` regenerates the HTML and DOCX reports with the screenshots embedded (python-docx needed). In Word, right-click the table of contents → Update Field.
4. `./make-submission-zip.sh` produces `../2025MT03141_FoodExpress.zip`.

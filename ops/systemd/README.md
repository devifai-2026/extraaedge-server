# systemd setup

```bash
sudo cp extraaedge-api.service /etc/systemd/system/
sudo cp [email protected] /etc/systemd/system/

sudo mkdir -p /var/log/extraaedge /etc/extraaedge /opt/extraaedge
sudo useradd -r extraaedge
# Deploy code to /opt/extraaedge
# Put .env at /etc/extraaedge/.env (mode 600, owner root)

sudo systemctl daemon-reload
sudo systemctl enable --now extraaedge-api.service

# Start workers individually (one systemd unit per worker via the template):
for w in email-sender sms-sender whatsapp-sender notification-worker \
         bulk-import-worker bulk-export-worker campaign-runner \
         drip-scheduler scheduled-send-runner workflow-executor \
         rule-processor outbound-webhook-dispatcher pdf-report-worker \
         duplicate-scanner followup-reminder-scheduler missed-followup-scanner \
         sla-scanner referral-crediter attribution-snapshotter touch-recorder; do
  sudo systemctl enable --now extraaedge-worker@$w.service
done
```

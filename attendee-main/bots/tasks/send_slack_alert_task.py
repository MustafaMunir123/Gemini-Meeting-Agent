import logging
import os

import requests
from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(
    bind=True,
    max_retries=2,
)
def send_slack_alert(self, message: str):
    """
    Send a message to Slack via webhook.
    Only sends if SLACK_WEBHOOK_URL environment variable is defined.
    """
    slack_webhook_url = os.getenv("SLACK_WEBHOOK_URL")
    if not slack_webhook_url:
        logger.debug("SLACK_WEBHOOK_URL not configured, skipping Slack notification")
        return

    try:
        response = requests.post(
            slack_webhook_url,
            json={"text": message},
            timeout=5,
        )
        response.raise_for_status()
        logger.info(f"Slack webhook sent successfully: {message[:100]}")
    except Exception as e:
        logger.warning(f"Failed to send Slack webhook: {e}")
        # Don't retry on failure, just log and move on

import logging

from bots.models import ZoomOAuthConnection, ZoomOAuthConnectionStates
from bots.zoom_oauth_connections_utils import _get_access_token

logger = logging.getLogger(__name__)

from celery import shared_task

from bots.models import WebhookTriggerTypes, ZoomOAuthApp
from bots.webhook_utils import trigger_webhook
from bots.zoom_oauth_connections_utils import zoom_oauth_connection_webhook_payload


@shared_task(
    bind=True,
    autoretry_for=(Exception,),
    retry_backoff=True,  # Enable exponential backoff
    max_retries=1,
)
def validate_zoom_oauth_connections(self, zoom_oauth_app_id):
    """Celery task to sync zoom meetings with a zoom oauth connection."""
    logger.info(f"Validating zoom oauth connections for zoom oauth app {zoom_oauth_app_id}")
    zoom_oauth_app = ZoomOAuthApp.objects.get(id=zoom_oauth_app_id)

    # Get all zoom oauth connections which are in state disconnected

    disconnected_zoom_oauth_connections = ZoomOAuthConnection.objects.filter(zoom_oauth_app=zoom_oauth_app, state=ZoomOAuthConnectionStates.DISCONNECTED)
    for zoom_oauth_connection in disconnected_zoom_oauth_connections:
        connection_failure_error = (zoom_oauth_connection.connection_failure_data or {}).get("error")
        if not connection_failure_error:
            continue
        # We are only interested in errors that are related to the client_id or client_secret being invalid
        if "Invalid client_id or client_secret" not in connection_failure_error:
            continue

        # Try to validate the zoom oauth connection
        try:
            access_token = _get_access_token(zoom_oauth_connection)

            if not access_token:
                continue

            # If the access token is present, then update the state to CONNECTED
            zoom_oauth_connection.state = ZoomOAuthConnectionStates.CONNECTED
            zoom_oauth_connection.connection_failure_data = None
            zoom_oauth_connection.save()

            # Trigger a webhook event
            trigger_webhook(
                webhook_trigger_type=WebhookTriggerTypes.ZOOM_OAUTH_CONNECTION_STATE_CHANGE,
                zoom_oauth_connection=zoom_oauth_connection,
                payload=zoom_oauth_connection_webhook_payload(zoom_oauth_connection),
            )
        except Exception as e:
            logger.exception(f"Zoom OAuth connection validation failed with {type(e).__name__} for {zoom_oauth_connection.id}: {e}")
            continue

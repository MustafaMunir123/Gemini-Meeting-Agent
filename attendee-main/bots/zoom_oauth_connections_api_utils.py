import base64
import logging
import uuid

import requests
from django.db import IntegrityError, transaction

from .models import ZoomOAuthApp, ZoomOAuthConnection, ZoomOAuthConnectionStates
from .serializers import CreateZoomOAuthConnectionSerializer

logger = logging.getLogger(__name__)


def _get_user_info(access_token: str) -> dict:
    # Step 1 – who is the user?
    resp = requests.get("https://api.zoom.us/v2/users/me", headers={"Authorization": f"Bearer {access_token}"}, timeout=10)
    resp.raise_for_status()
    return resp.json()  # {id, first_name, last_name, email}


def _exchange_access_code_for_tokens(code: str, redirect_uri: str, client_id: str, client_secret: str) -> dict:
    """POST the authorization code to /oauth/token to get access & refresh."""
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    headers = {"Authorization": f"Basic {basic}"}
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }
    resp = requests.post("https://zoom.us/oauth/token", headers=headers, data=data, timeout=10)
    resp.raise_for_status()
    return resp.json()  # {access_token, refresh_token, expires_in, …}


def create_zoom_oauth_connection(data, project):
    """
    Create a new zoom oauth connection for the given project.

    Args:
        data: Dictionary containing zoom oauth connection creation data
        project: Project instance to associate the zoom oauth connection with

    Returns:
        tuple: (zoom_oauth_connection_instance, error_dict)
               Returns (ZoomOAuthConnection, None) on success
               Returns (None, error_dict) on failure
    """
    # Validate the input data
    serializer = CreateZoomOAuthConnectionSerializer(data=data)
    if not serializer.is_valid():
        return None, serializer.errors

    validated_data = serializer.validated_data

    # Validate that the Zoom OAuth App exists in the project
    zoom_oauth_app = None
    try:
        if validated_data["zoom_oauth_app_id"]:
            zoom_oauth_app = ZoomOAuthApp.objects.get(object_id=validated_data["zoom_oauth_app_id"], project=project)
        else:
            zoom_oauth_app = ZoomOAuthApp.objects.get(project=project)
    except ZoomOAuthApp.DoesNotExist:
        if validated_data["zoom_oauth_app_id"]:
            return None, {"error": f"Zoom OAuth App with id {validated_data['zoom_oauth_app_id']} does not exist in this project ({project.name})."}
        else:
            return None, {"error": f"No Zoom OAuth App found in this project ({project.name}). Please add a Zoom OAuth App first."}

    # Exchange the access code for tokens
    zoom_oauth_tokens = None
    try:
        zoom_oauth_tokens = _exchange_access_code_for_tokens(
            code=validated_data["authorization_code"],
            redirect_uri=validated_data["redirect_uri"],
            client_id=zoom_oauth_app.client_id,
            client_secret=zoom_oauth_app.client_secret,
        )
    except Exception as e:
        logger.error(f"Error exchanging access code for tokens: {e}")
        return None, {"error": "Error exchanging access code for tokens. Please check that the authorization code and redirect URI are correct."}

    # Validate that the tokens have the required scopes
    scopes_for_token = zoom_oauth_tokens.get("scope", "").split(" ")

    # Minimum scopes depends on what the capabilities of the zoom oauth connection are.
    minimum_scopes_for_token = []
    if validated_data.get("is_local_recording_token_supported"):
        minimum_scopes_for_token.extend(["user:read:user", "user:read:zak", "meeting:read:list_meetings", "meeting:read:local_recording_token"])
    if validated_data.get("is_onbehalf_token_supported"):
        minimum_scopes_for_token.extend(["user:read:user", "user:read:token"])
    # Uniqify the scopes
    minimum_scopes_for_token = list(set(minimum_scopes_for_token))

    missing_scopes = [scope for scope in minimum_scopes_for_token if scope not in scopes_for_token]
    if missing_scopes:
        return None, {"error": f"The authorization is missing the following required scopes: {missing_scopes}."}

    # Get the user info
    user_info = None
    try:
        user_info = _get_user_info(zoom_oauth_tokens["access_token"])
    except Exception as e:
        logger.error(f"Error getting user info: {e}")
        return None, {"error": "Error getting user info. Please check that the access token is valid."}

    # Validate that the user is active
    if user_info["status"] != "active":
        return None, {"error": "The user is not active."}

    try:
        with transaction.atomic():
            zoom_oauth_connection, created = ZoomOAuthConnection.objects.get_or_create(zoom_oauth_app=zoom_oauth_app, user_id=user_info["id"])

            # Set encrypted credentials (refresh_token)
            credentials = {"refresh_token": zoom_oauth_tokens["refresh_token"]}
            zoom_oauth_connection.set_credentials(credentials)

            zoom_oauth_connection.account_id = user_info["account_id"]
            zoom_oauth_connection.metadata = validated_data["metadata"]

            # Set the capabilities
            zoom_oauth_connection.is_local_recording_token_supported = validated_data.get("is_local_recording_token_supported")
            zoom_oauth_connection.is_onbehalf_token_supported = validated_data.get("is_onbehalf_token_supported")

            # Set the state to connected
            zoom_oauth_connection.state = ZoomOAuthConnectionStates.CONNECTED
            zoom_oauth_connection.connection_failure_data = None

            # Save the zoom oauth connection
            zoom_oauth_connection.save()

            return zoom_oauth_connection, None

    except IntegrityError as e:
        error_id = str(uuid.uuid4())
        logger.error(f"Error creating zoom oauth connection (error_id={error_id}): {e}")
        return None, {"non_field_errors": ["An error occurred while creating the zoom oauth connection. Error ID: " + error_id]}
    except Exception as e:
        error_id = str(uuid.uuid4())
        logger.error(f"Error creating zoom oauth connection (error_id={error_id}): {e}")
        return None, {"non_field_errors": ["An unexpected error occurred while creating the zoom oauth connection. Error ID: " + error_id]}

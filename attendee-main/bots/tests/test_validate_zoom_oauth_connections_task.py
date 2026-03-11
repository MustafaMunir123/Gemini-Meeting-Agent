from unittest.mock import patch

from django.test import TestCase

from accounts.models import Organization
from bots.models import (
    Project,
    ZoomOAuthApp,
    ZoomOAuthConnection,
    ZoomOAuthConnectionStates,
)
from bots.tasks.validate_zoom_oauth_connections_task import (
    validate_zoom_oauth_connections,
)


class TestValidateZoomOAuthConnections(TestCase):
    """Test the validate_zoom_oauth_connections Celery task."""

    def setUp(self):
        self.organization = Organization.objects.create(name="Test Org")
        self.project = Project.objects.create(name="Test Project", organization=self.organization)
        self.zoom_oauth_app = ZoomOAuthApp.objects.create(project=self.project, client_id="test_client_id")
        self.zoom_oauth_app.set_credentials({"client_secret": "test_secret"})

    @patch("bots.tasks.validate_zoom_oauth_connections_task.trigger_webhook")
    @patch("bots.tasks.validate_zoom_oauth_connections_task._get_access_token")
    def test_validate_multiple_disconnected_connections_success(self, mock_get_access_token, mock_trigger_webhook):
        """Test successful validation of multiple disconnected zoom oauth connections."""
        # Create multiple disconnected connections with invalid client error
        connection_1 = ZoomOAuthConnection.objects.create(
            zoom_oauth_app=self.zoom_oauth_app,
            user_id="user_1",
            account_id="account_1",
            state=ZoomOAuthConnectionStates.DISCONNECTED,
            connection_failure_data={
                "error": "Invalid client_id or client_secret",
                "timestamp": "2025-10-16T12:00:00Z",
            },
        )
        connection_1.set_credentials({"refresh_token": "refresh_token_1"})

        connection_2 = ZoomOAuthConnection.objects.create(
            zoom_oauth_app=self.zoom_oauth_app,
            user_id="user_2",
            account_id="account_2",
            state=ZoomOAuthConnectionStates.DISCONNECTED,
            connection_failure_data={
                "error": "Invalid client_id or client_secret",
                "timestamp": "2025-10-16T12:00:00Z",
            },
        )
        connection_2.set_credentials({"refresh_token": "refresh_token_2"})

        connection_3 = ZoomOAuthConnection.objects.create(
            zoom_oauth_app=self.zoom_oauth_app,
            user_id="user_3",
            account_id="account_3",
            state=ZoomOAuthConnectionStates.DISCONNECTED,
            connection_failure_data={
                "error": "Invalid client_id or client_secret",
                "timestamp": "2025-10-16T12:00:00Z",
            },
        )
        connection_3.set_credentials({"refresh_token": "refresh_token_3"})

        # Mock successful access token retrieval for all connections
        mock_get_access_token.return_value = "mock_access_token"

        # Run the task
        validate_zoom_oauth_connections(self.zoom_oauth_app.id)

        # Verify all connections were validated
        self.assertEqual(mock_get_access_token.call_count, 3)

        # Verify all connection states were updated
        connection_1.refresh_from_db()
        self.assertEqual(connection_1.state, ZoomOAuthConnectionStates.CONNECTED)
        self.assertIsNone(connection_1.connection_failure_data)

        connection_2.refresh_from_db()
        self.assertEqual(connection_2.state, ZoomOAuthConnectionStates.CONNECTED)
        self.assertIsNone(connection_2.connection_failure_data)

        connection_3.refresh_from_db()
        self.assertEqual(connection_3.state, ZoomOAuthConnectionStates.CONNECTED)
        self.assertIsNone(connection_3.connection_failure_data)

        # Verify webhook was triggered for each connection
        self.assertEqual(mock_trigger_webhook.call_count, 3)

    @patch("bots.tasks.validate_zoom_oauth_connections_task._get_access_token")
    def test_validate_ignores_connections_without_invalid_client_error(self, mock_get_access_token):
        """Test that validation ignores disconnected connections without invalid client error."""
        # Create disconnected connection with different error
        zoom_oauth_connection = ZoomOAuthConnection.objects.create(
            zoom_oauth_app=self.zoom_oauth_app,
            user_id="test_user_id",
            account_id="test_account_id",
            state=ZoomOAuthConnectionStates.DISCONNECTED,
            connection_failure_data={
                "error": "Network timeout",
                "timestamp": "2025-10-16T12:00:00Z",
            },
        )
        zoom_oauth_connection.set_credentials({"refresh_token": "test_refresh_token"})

        # Run the task
        validate_zoom_oauth_connections(self.zoom_oauth_app.id)

        # Verify the connection was not validated
        mock_get_access_token.assert_not_called()

        # Verify the connection state was not updated
        zoom_oauth_connection.refresh_from_db()
        self.assertEqual(zoom_oauth_connection.state, ZoomOAuthConnectionStates.DISCONNECTED)
        self.assertIsNotNone(zoom_oauth_connection.connection_failure_data)

    @patch("bots.tasks.validate_zoom_oauth_connections_task._get_access_token")
    def test_validate_ignores_connected_connections(self, mock_get_access_token):
        """Test that validation ignores already connected connections."""
        # Create connected connection
        zoom_oauth_connection = ZoomOAuthConnection.objects.create(
            zoom_oauth_app=self.zoom_oauth_app,
            user_id="test_user_id",
            account_id="test_account_id",
            state=ZoomOAuthConnectionStates.CONNECTED,
            connection_failure_data=None,
        )
        zoom_oauth_connection.set_credentials({"refresh_token": "test_refresh_token"})

        # Run the task
        validate_zoom_oauth_connections(self.zoom_oauth_app.id)

        # Verify the connection was not validated
        mock_get_access_token.assert_not_called()

    @patch("bots.tasks.validate_zoom_oauth_connections_task._get_access_token")
    def test_validate_connection_continues_on_no_access_token(self, mock_get_access_token):
        """Test that validation continues if access token is not returned."""
        # Create disconnected connection
        zoom_oauth_connection = ZoomOAuthConnection.objects.create(
            zoom_oauth_app=self.zoom_oauth_app,
            user_id="test_user_id",
            account_id="test_account_id",
            state=ZoomOAuthConnectionStates.DISCONNECTED,
            connection_failure_data={
                "error": "Invalid client_id or client_secret",
                "timestamp": "2025-10-16T12:00:00Z",
            },
        )
        zoom_oauth_connection.set_credentials({"refresh_token": "test_refresh_token"})

        # Mock access token retrieval returning None
        mock_get_access_token.return_value = None

        # Run the task - should not raise exception
        validate_zoom_oauth_connections(self.zoom_oauth_app.id)

        # Verify the connection state was not updated
        zoom_oauth_connection.refresh_from_db()
        self.assertEqual(zoom_oauth_connection.state, ZoomOAuthConnectionStates.DISCONNECTED)
        self.assertIsNotNone(zoom_oauth_connection.connection_failure_data)

    @patch("bots.tasks.validate_zoom_oauth_connections_task.trigger_webhook")
    @patch("bots.tasks.validate_zoom_oauth_connections_task._get_access_token")
    def test_validate_connection_continues_on_exception(self, mock_get_access_token, mock_trigger_webhook):
        """Test that validation continues processing other connections if one fails."""
        # Create two disconnected connections
        connection_1 = ZoomOAuthConnection.objects.create(
            zoom_oauth_app=self.zoom_oauth_app,
            user_id="user_1",
            account_id="account_1",
            state=ZoomOAuthConnectionStates.DISCONNECTED,
            connection_failure_data={
                "error": "Invalid client_id or client_secret",
                "timestamp": "2025-10-16T12:00:00Z",
            },
        )
        connection_1.set_credentials({"refresh_token": "refresh_token_1"})

        connection_2 = ZoomOAuthConnection.objects.create(
            zoom_oauth_app=self.zoom_oauth_app,
            user_id="user_2",
            account_id="account_2",
            state=ZoomOAuthConnectionStates.DISCONNECTED,
            connection_failure_data={
                "error": "Invalid client_id or client_secret",
                "timestamp": "2025-10-16T12:00:00Z",
            },
        )
        connection_2.set_credentials({"refresh_token": "refresh_token_2"})

        # Mock access token retrieval to fail for first connection, succeed for second
        def mock_get_access_token_side_effect(connection):
            if connection == connection_1:
                raise Exception("Network error")
            return "mock_access_token"

        mock_get_access_token.side_effect = mock_get_access_token_side_effect

        # Run the task - should not raise exception
        validate_zoom_oauth_connections(self.zoom_oauth_app.id)

        # Verify both connections were attempted
        self.assertEqual(mock_get_access_token.call_count, 2)

        # Verify first connection state was not updated
        connection_1.refresh_from_db()
        self.assertEqual(connection_1.state, ZoomOAuthConnectionStates.DISCONNECTED)
        self.assertIsNotNone(connection_1.connection_failure_data)

        # Verify second connection state was updated
        connection_2.refresh_from_db()
        self.assertEqual(connection_2.state, ZoomOAuthConnectionStates.CONNECTED)
        self.assertIsNone(connection_2.connection_failure_data)

        # Verify webhook was triggered only once for successful connection
        mock_trigger_webhook.assert_called_once()

    @patch("bots.tasks.validate_zoom_oauth_connections_task.trigger_webhook")
    @patch("bots.tasks.validate_zoom_oauth_connections_task._get_access_token")
    def test_validate_mixed_connections_only_validates_eligible(self, mock_get_access_token, mock_trigger_webhook):
        """Test that validation only processes eligible disconnected connections with invalid client error."""
        # Create multiple connections with different states and errors
        # Eligible connection
        eligible_connection = ZoomOAuthConnection.objects.create(
            zoom_oauth_app=self.zoom_oauth_app,
            user_id="eligible_user",
            account_id="eligible_account",
            state=ZoomOAuthConnectionStates.DISCONNECTED,
            connection_failure_data={
                "error": "Invalid client_id or client_secret",
                "timestamp": "2025-10-16T12:00:00Z",
            },
        )
        eligible_connection.set_credentials({"refresh_token": "eligible_refresh_token"})

        # Connected connection (not eligible)
        connected_connection = ZoomOAuthConnection.objects.create(
            zoom_oauth_app=self.zoom_oauth_app,
            user_id="connected_user",
            account_id="connected_account",
            state=ZoomOAuthConnectionStates.CONNECTED,
            connection_failure_data=None,
        )
        connected_connection.set_credentials({"refresh_token": "connected_refresh_token"})

        # Disconnected connection with different error (not eligible)
        different_error_connection = ZoomOAuthConnection.objects.create(
            zoom_oauth_app=self.zoom_oauth_app,
            user_id="different_error_user",
            account_id="different_error_account",
            state=ZoomOAuthConnectionStates.DISCONNECTED,
            connection_failure_data={
                "error": "Token expired",
                "timestamp": "2025-10-16T12:00:00Z",
            },
        )
        different_error_connection.set_credentials({"refresh_token": "different_error_refresh_token"})

        # Disconnected connection without failure data (not eligible)
        no_failure_data_connection = ZoomOAuthConnection.objects.create(
            zoom_oauth_app=self.zoom_oauth_app,
            user_id="no_failure_data_user",
            account_id="no_failure_data_account",
            state=ZoomOAuthConnectionStates.DISCONNECTED,
            connection_failure_data=None,
        )
        no_failure_data_connection.set_credentials({"refresh_token": "no_failure_data_refresh_token"})

        # Mock successful access token retrieval
        mock_get_access_token.return_value = "mock_access_token"

        # Run the task
        validate_zoom_oauth_connections(self.zoom_oauth_app.id)

        # Verify only eligible connection was validated
        mock_get_access_token.assert_called_once_with(eligible_connection)

        # Verify only eligible connection state was updated
        eligible_connection.refresh_from_db()
        self.assertEqual(eligible_connection.state, ZoomOAuthConnectionStates.CONNECTED)
        self.assertIsNone(eligible_connection.connection_failure_data)

        # Verify other connections were not modified
        connected_connection.refresh_from_db()
        self.assertEqual(connected_connection.state, ZoomOAuthConnectionStates.CONNECTED)

        different_error_connection.refresh_from_db()
        self.assertEqual(different_error_connection.state, ZoomOAuthConnectionStates.DISCONNECTED)
        self.assertIsNotNone(different_error_connection.connection_failure_data)

        no_failure_data_connection.refresh_from_db()
        self.assertEqual(no_failure_data_connection.state, ZoomOAuthConnectionStates.DISCONNECTED)
        self.assertIsNone(no_failure_data_connection.connection_failure_data)

        # Verify webhook was triggered only once
        mock_trigger_webhook.assert_called_once()

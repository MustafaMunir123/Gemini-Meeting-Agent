from unittest.mock import patch

from django.test import TestCase

from accounts.models import Organization
from bots.models import Bot, Project, RecordingFormats, RecordingTypes


class TestBotCpuRequest(TestCase):
    def setUp(self):
        """Set up test data"""
        self.organization = Organization.objects.create(name="Test Organization")
        self.project = Project.objects.create(name="Test Project", organization=self.organization)

    def create_bot(self, meeting_url, recording_settings=None):
        """Helper method to create a bot with given settings"""
        settings = {}
        if recording_settings:
            settings["recording_settings"] = recording_settings

        return Bot.objects.create(
            name="Test Bot",
            project=self.project,
            meeting_url=meeting_url,
            settings=settings,
        )

    @patch("bots.models.os.getenv")
    def test_google_meet_audio_video_cpu_request(self, mock_getenv):
        """Test CPU request for Google Meet with audio and video recording"""
        # Set up environment variable mock
        mock_getenv.side_effect = lambda key, default=None: {
            "GOOGLE_MEET_AUDIO_AND_VIDEO_BOT_CPU_REQUEST": "8",
            "BOT_CPU_REQUEST": "4",
        }.get(key, default)

        bot = self.create_bot("https://meet.google.com/abc-defg-hij")

        result = bot.cpu_request()

        self.assertEqual(result, "8")
        # Verify the correct environment variable was checked
        mock_getenv.assert_any_call("GOOGLE_MEET_AUDIO_AND_VIDEO_BOT_CPU_REQUEST", "4")

    @patch("bots.models.os.getenv")
    def test_google_meet_audio_only_cpu_request(self, mock_getenv):
        """Test CPU request for Google Meet with audio only recording"""
        mock_getenv.side_effect = lambda key, default=None: {
            "GOOGLE_MEET_AUDIO_ONLY_BOT_CPU_REQUEST": "2",
            "BOT_CPU_REQUEST": "4",
        }.get(key, default)

        bot = self.create_bot("https://meet.google.com/abc-defg-hij", recording_settings={"format": RecordingFormats.MP3})

        result = bot.cpu_request()

        self.assertEqual(result, "2")
        mock_getenv.assert_any_call("GOOGLE_MEET_AUDIO_ONLY_BOT_CPU_REQUEST", "4")

    @patch("bots.models.os.getenv")
    def test_zoom_audio_video_cpu_request(self, mock_getenv):
        """Test CPU request for Zoom with audio and video recording"""
        mock_getenv.side_effect = lambda key, default=None: {
            "ZOOM_AUDIO_AND_VIDEO_BOT_CPU_REQUEST": "6",
            "BOT_CPU_REQUEST": "4",
        }.get(key, default)

        bot = self.create_bot("https://zoom.us/j/123456789")

        result = bot.cpu_request()

        self.assertEqual(result, "6")
        mock_getenv.assert_any_call("ZOOM_AUDIO_AND_VIDEO_BOT_CPU_REQUEST", "4")

    @patch("bots.models.os.getenv")
    def test_zoom_audio_only_cpu_request(self, mock_getenv):
        """Test CPU request for Zoom with audio only recording"""
        mock_getenv.side_effect = lambda key, default=None: {
            "ZOOM_AUDIO_ONLY_BOT_CPU_REQUEST": "3",
            "BOT_CPU_REQUEST": "4",
        }.get(key, default)

        bot = self.create_bot("https://zoom.us/j/123456789", recording_settings={"format": RecordingFormats.MP3})

        result = bot.cpu_request()

        self.assertEqual(result, "3")
        mock_getenv.assert_any_call("ZOOM_AUDIO_ONLY_BOT_CPU_REQUEST", "4")

    @patch("bots.models.os.getenv")
    def test_teams_audio_video_cpu_request(self, mock_getenv):
        """Test CPU request for Teams with audio and video recording"""
        mock_getenv.side_effect = lambda key, default=None: {
            "TEAMS_AUDIO_AND_VIDEO_BOT_CPU_REQUEST": "7",
            "BOT_CPU_REQUEST": "4",
        }.get(key, default)

        bot = self.create_bot("https://teams.microsoft.com/meet/123123213?p=123123213")

        result = bot.cpu_request()

        self.assertEqual(result, "7")
        mock_getenv.assert_any_call("TEAMS_AUDIO_AND_VIDEO_BOT_CPU_REQUEST", "4")

    @patch("bots.models.os.getenv")
    def test_teams_audio_only_cpu_request(self, mock_getenv):
        """Test CPU request for Teams with audio only recording"""
        mock_getenv.side_effect = lambda key, default=None: {
            "TEAMS_AUDIO_ONLY_BOT_CPU_REQUEST": "1",
            "BOT_CPU_REQUEST": "4",
        }.get(key, default)

        bot = self.create_bot("https://teams.microsoft.com/meet/123123213?p=123123213", recording_settings={"format": RecordingFormats.MP3})

        result = bot.cpu_request()

        self.assertEqual(result, "1")
        mock_getenv.assert_any_call("TEAMS_AUDIO_ONLY_BOT_CPU_REQUEST", "4")

    @patch("bots.models.os.getenv")
    def test_unknown_meeting_type_fallback(self, mock_getenv):
        """Test CPU request fallback for unknown meeting type"""
        mock_getenv.side_effect = lambda key, default=None: {
            "BOT_CPU_REQUEST": "4",
        }.get(key, default)

        bot = self.create_bot("https://some-unknown-meeting-platform.com/meeting/123")

        result = bot.cpu_request()

        self.assertEqual(result, "4")
        # Should try unknown meeting type first, then fall back to default
        mock_getenv.assert_any_call("UNKNOWN_AUDIO_AND_VIDEO_BOT_CPU_REQUEST", "4")

    @patch("bots.models.os.getenv")
    def test_fallback_to_default_when_specific_env_var_not_set(self, mock_getenv):
        """Test fallback to default BOT_CPU_REQUEST when specific env var is not set"""
        mock_getenv.side_effect = lambda key, default=None: {
            "BOT_CPU_REQUEST": "5",
            # GOOGLE_MEET_AUDIO_AND_VIDEO_BOT_CPU_REQUEST is not set
        }.get(key, default)

        bot = self.create_bot("https://meet.google.com/abc-defg-hij")

        result = bot.cpu_request()

        self.assertEqual(result, "5")
        mock_getenv.assert_any_call("GOOGLE_MEET_AUDIO_AND_VIDEO_BOT_CPU_REQUEST", "5")

    @patch("bots.models.os.getenv")
    def test_fallback_to_hardcoded_default_when_no_env_vars_set(self, mock_getenv):
        """Test fallback to hardcoded default when no environment variables are set"""
        mock_getenv.side_effect = (
            lambda key, default=None: {
                # No environment variables set
            }.get(key, default)
        )

        bot = self.create_bot("https://meet.google.com/abc-defg-hij")

        result = bot.cpu_request()

        self.assertEqual(result, "4")  # Hardcoded default
        mock_getenv.assert_any_call("BOT_CPU_REQUEST", "4")
        mock_getenv.assert_any_call("GOOGLE_MEET_AUDIO_AND_VIDEO_BOT_CPU_REQUEST", "4")

    @patch("bots.models.os.getenv")
    def test_webm_format_maps_to_audio_and_video(self, mock_getenv):
        """Test that WEBM format is treated as audio and video recording"""
        mock_getenv.side_effect = lambda key, default=None: {
            "GOOGLE_MEET_AUDIO_AND_VIDEO_BOT_CPU_REQUEST": "10",
            "BOT_CPU_REQUEST": "4",
        }.get(key, default)

        bot = self.create_bot("https://meet.google.com/abc-defg-hij", recording_settings={"format": RecordingFormats.WEBM})

        result = bot.cpu_request()

        self.assertEqual(result, "10")
        mock_getenv.assert_any_call("GOOGLE_MEET_AUDIO_AND_VIDEO_BOT_CPU_REQUEST", "4")

    @patch("bots.models.os.getenv")
    def test_mp4_format_maps_to_audio_and_video(self, mock_getenv):
        """Test that MP4 format is treated as audio and video recording (default)"""
        mock_getenv.side_effect = lambda key, default=None: {
            "TEAMS_AUDIO_AND_VIDEO_BOT_CPU_REQUEST": "12",
            "BOT_CPU_REQUEST": "4",
        }.get(key, default)

        # Not setting recording_settings means it defaults to MP4
        bot = self.create_bot("https://teams.microsoft.com/meet/123123213?p=123123213")

        result = bot.cpu_request()

        self.assertEqual(result, "12")
        mock_getenv.assert_any_call("TEAMS_AUDIO_AND_VIDEO_BOT_CPU_REQUEST", "4")

    @patch("bots.models.os.getenv")
    def test_different_default_bot_cpu_request(self, mock_getenv):
        """Test with different default BOT_CPU_REQUEST value"""
        mock_getenv.side_effect = lambda key, default=None: {
            "BOT_CPU_REQUEST": "16",
            # Specific meeting type env var not set
        }.get(key, default)

        bot = self.create_bot("https://zoom.us/j/987654321")

        result = bot.cpu_request()

        self.assertEqual(result, "16")
        mock_getenv.assert_any_call("BOT_CPU_REQUEST", "4")
        mock_getenv.assert_any_call("ZOOM_AUDIO_AND_VIDEO_BOT_CPU_REQUEST", "16")

    def test_recording_type_derivation_from_settings(self):
        """Test that recording type is correctly derived from settings"""
        # Test MP4 -> AUDIO_AND_VIDEO
        bot_mp4 = self.create_bot("https://meet.google.com/test", recording_settings={"format": RecordingFormats.MP4})
        self.assertEqual(bot_mp4.recording_type(), RecordingTypes.AUDIO_AND_VIDEO)

        # Test WEBM -> AUDIO_AND_VIDEO
        bot_webm = self.create_bot("https://meet.google.com/test2", recording_settings={"format": RecordingFormats.WEBM})
        self.assertEqual(bot_webm.recording_type(), RecordingTypes.AUDIO_AND_VIDEO)

        # Test MP3 -> AUDIO_ONLY
        bot_mp3 = self.create_bot("https://meet.google.com/test3", recording_settings={"format": RecordingFormats.MP3})
        self.assertEqual(bot_mp3.recording_type(), RecordingTypes.AUDIO_ONLY)

    @patch("bots.models.os.getenv")
    def test_multiple_bots_different_configurations(self, mock_getenv):
        """Test multiple bots with different meeting types and recording formats"""
        mock_getenv.side_effect = lambda key, default=None: {
            "GOOGLE_MEET_AUDIO_AND_VIDEO_BOT_CPU_REQUEST": "8",
            "ZOOM_AUDIO_ONLY_BOT_CPU_REQUEST": "2",
            "TEAMS_AUDIO_AND_VIDEO_BOT_CPU_REQUEST": "10",
            "BOT_CPU_REQUEST": "4",
        }.get(key, default)

        # Google Meet with default settings (MP4 - audio and video)
        bot1 = self.create_bot("https://meet.google.com/abc-defg-hij")
        self.assertEqual(bot1.cpu_request(), "8")

        # Zoom with MP3 (audio only)
        bot2 = self.create_bot("https://zoom.us/j/123456789", recording_settings={"format": RecordingFormats.MP3})
        self.assertEqual(bot2.cpu_request(), "2")

        # Teams with WEBM (audio and video)
        bot3 = self.create_bot("https://teams.microsoft.com/meet/123123213?p=123123213", recording_settings={"format": RecordingFormats.WEBM})
        self.assertEqual(bot3.cpu_request(), "10")

    @patch("bots.models.os.getenv")
    def test_edge_case_empty_env_var_value(self, mock_getenv):
        """Test edge case where env var is set but empty"""
        mock_getenv.side_effect = lambda key, default=None: {
            "GOOGLE_MEET_AUDIO_AND_VIDEO_BOT_CPU_REQUEST": "",  # Empty string
            "BOT_CPU_REQUEST": "4",
        }.get(key, default)

        bot = self.create_bot("https://meet.google.com/abc-defg-hij")

        result = bot.cpu_request()

        # Should return 4 if the env var is empty.
        self.assertEqual(result, "4")

    @patch("bots.models.os.getenv")
    def test_edge_case_empty_everything(self, mock_getenv):
        # Simultate that no env vars are set
        mock_getenv.side_effect = lambda key, default=None: None

        bot = self.create_bot("https://meet.google.com/abc-defg-hij")

        result = bot.cpu_request()

        # Should return 4 if the env var is empty.
        self.assertEqual(result, "4")

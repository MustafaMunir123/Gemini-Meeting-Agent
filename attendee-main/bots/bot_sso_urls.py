from django.urls import path

from . import bot_sso_views

app_name = "bot_sso"

urlpatterns = [
    path(
        "google_meet_sign_in",
        bot_sso_views.GoogleMeetSignInView.as_view(),
        name="google_meet_sign_in",
    ),
    path(
        "google_meet_sign_out",
        bot_sso_views.GoogleMeetSignOutView.as_view(),
        name="google_meet_sign_out",
    ),
    path(
        "google_meet_set_cookie",
        bot_sso_views.GoogleMeetSetCookieView.as_view(),
        name="google_meet_set_cookie",
    ),
]

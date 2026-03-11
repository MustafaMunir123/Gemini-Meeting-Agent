#!/usr/bin/env python3
import argparse
import concurrent.futures
import json
import random
import sys
import time
from typing import Dict, List, Optional, Tuple

import requests

# ----------------------------
# Helpers / HTTP
# ----------------------------


class AttendeeClient:
    def __init__(self, base_url: str, api_key: str, timeout=30):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Token {api_key}",
                "Content-Type": "application/json",
            }
        )
        self.timeout = timeout

    def _url(self, path: str) -> str:
        if not path.startswith("/"):
            path = "/" + path
        return f"{self.base_url}{path}"

    def create_bot(self, meeting_url: str, bot_name: str, extra: Optional[Dict] = None) -> Dict:
        payload = {"meeting_url": meeting_url, "bot_name": bot_name, "transcription_settings": {"assembly_ai": {}}}
        if extra:
            payload.update(extra)
        r = self.session.post(self._url("/api/v1/bots"), data=json.dumps(payload), timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def get_bot(self, bot_id: str) -> Dict:
        r = self.session.get(self._url(f"/api/v1/bots/{bot_id}"), timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def tell_bot_to_leave(self, bot_id: str) -> None:
        """
        Try preferred leave endpoint; fall back to DELETE if supported by your deployment.
        """
        # Try POST /leave first
        try:
            r = self.session.post(self._url(f"/api/v1/bots/{bot_id}/leave"), timeout=self.timeout)
            if r.status_code in (200, 202, 204):
                return
        except requests.RequestException as e:
            print(f"Error telling bot {bot_id} to leave: {e}")
            pass

        # Fallback: DELETE bot (if supported)
        try:
            r = self.session.delete(self._url(f"/api/v1/bots/{bot_id}"), timeout=self.timeout)
            if r.status_code in (200, 202, 204):
                return
        except requests.RequestException:
            pass

    def output_video(self, bot_id: str, video_url: str) -> None:
        """
        Sends a video URL to be played into the meeting.
        """
        json_payload = {"url": video_url}
        url = self._url(f"/api/v1/bots/{bot_id}/output_video")

        r = self.session.post(url, data=json.dumps(json_payload), timeout=self.timeout)
        r.raise_for_status()


# ----------------------------
# Core workflow
# ----------------------------


def state_is_joined_recording(state: str) -> bool:
    s = (state or "").strip().lower()
    # Accept fuzzy match to handle human-readable values like "Joined - Recording"
    return "joined" in s and "record" in s


def wait_for_state(client: AttendeeClient, bot_id: str, predicate, desc: str, timeout_s: int, poll_s: float = 2.0) -> Dict:
    start = time.time()
    while True:
        bot = client.get_bot(bot_id)
        state = str(bot.get("state", ""))
        if predicate(state, bot):
            return bot
        if (time.time() - start) > timeout_s:
            raise TimeoutError(f"Timed out waiting for state '{desc}'. Last state={state!r}")
        time.sleep(poll_s)


def play_videos_for_bot(client: AttendeeClient, bot_id: str, bot_name: str, video_urls_with_durations: List[Tuple[str, float]], end_time: float, verbose: bool) -> None:
    """
    Continuously plays random videos for a bot until end_time is reached.
    Each video plays for its duration + 15 seconds buffer before playing the next.
    """
    while time.time() < end_time:
        video_url, duration = random.choice(video_urls_with_durations)

        if verbose:
            print(f"[{bot_name}] Playing video: {video_url} (duration: {duration}s)")

        try:
            client.output_video(bot_id, video_url)
        except Exception as e:
            print(f"[{bot_name}] Error playing video: {e}", file=sys.stderr)
            # Continue trying other videos
            time.sleep(5)
            continue

        # Wait for video duration + 15 second buffer
        wait_time = duration + 15
        time_remaining = end_time - time.time()

        # Don't wait longer than remaining time
        actual_wait = min(wait_time, time_remaining)

        if actual_wait > 0:
            if verbose:
                print(f"[{bot_name}] Waiting {actual_wait:.1f}s before next video")
            time.sleep(actual_wait)

    if verbose:
        print(f"[{bot_name}] Finished playing videos (time limit reached)")


def main():
    parser = argparse.ArgumentParser(description="Stress test: send multiple bots to a meeting to continuously play videos.")
    parser.add_argument("--api-key", required=True, help="Attendee API key")
    parser.add_argument("--base-url", required=True, help="Attendee base URL, e.g. https://staging.attendee.dev")
    parser.add_argument("--meeting-url", required=True, help="Meeting URL (must bypass waiting room)")
    parser.add_argument("--num-bots", type=int, default=16, help="Number of bots to send (default: 16)")
    parser.add_argument("--videos", required=True, nargs="+", help="List of video URLs with durations in format: url1:duration1 url2:duration2 (duration in seconds)")
    parser.add_argument("--meeting-duration", type=float, required=True, help="Total time in seconds for bots to stay in meeting")
    parser.add_argument("--join-timeout", type=int, default=180, help="Seconds to wait for each bot to join")
    parser.add_argument("--end-timeout", type=int, default=300, help="Seconds to wait for 'Ended'")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose output")
    args = parser.parse_args()

    # Parse video URLs and durations
    video_urls_with_durations = []
    for video_spec in args.videos:
        try:
            url, duration = video_spec.rsplit(":", 1)
            video_urls_with_durations.append((url, float(duration)))
        except ValueError:
            print(f"ERROR: Invalid video spec '{video_spec}'. Expected format: url:duration", file=sys.stderr)
            sys.exit(2)

    if not video_urls_with_durations:
        print("ERROR: At least one video URL with duration is required", file=sys.stderr)
        sys.exit(2)

    if args.verbose:
        print(f"Parsed {len(video_urls_with_durations)} video(s):")
        for url, duration in video_urls_with_durations:
            print(f"  - {url} ({duration}s)")

    client = AttendeeClient(args.base_url, args.api_key)

    # 1) Create N bots
    if args.verbose:
        print(f"\nCreating {args.num_bots} bots...")

    bots = []
    for i in range(args.num_bots):
        bot_name = f"Video Bot {i + 1}"
        try:
            bot = client.create_bot(meeting_url=args.meeting_url, bot_name=bot_name)
            bots.append((bot["id"], bot_name))
            if args.verbose:
                print(f"  Created: {bot['id']} ({bot_name})")
        except Exception as e:
            print(f"ERROR: Failed to create bot {bot_name}: {e}", file=sys.stderr)
            sys.exit(1)

    # 2) Wait for all bots to join
    if args.verbose:
        print(f"\nWaiting for all {args.num_bots} bots to join...")

    def _pred_joined(state: str, bot_obj: Dict) -> bool:
        return state_is_joined_recording(state)

    for bot_id, bot_name in bots:
        try:
            wait_for_state(client, bot_id, _pred_joined, "joined_recording", args.join_timeout)
            if args.verbose:
                print(f"  {bot_name} joined")
        except TimeoutError as e:
            print(f"ERROR: {bot_name} failed to join: {e}", file=sys.stderr)
            # Continue with other bots

    # 3) Start video playback for all bots concurrently
    if args.verbose:
        print(f"\nStarting video playback for {len(bots)} bots (duration: {args.meeting_duration}s)...")

    end_time = time.time() + args.meeting_duration

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.num_bots) as executor:
        futures = []
        for bot_id, bot_name in bots:
            future = executor.submit(play_videos_for_bot, client, bot_id, bot_name, video_urls_with_durations, end_time, args.verbose)
            futures.append(future)

        # Wait for all video playback to complete
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
            except Exception as e:
                print(f"ERROR during video playback: {e}", file=sys.stderr)

    # 4) Tell all bots to leave
    if args.verbose:
        print(f"\nTelling all {len(bots)} bots to leave...")

    for bot_id, bot_name in bots:
        try:
            client.tell_bot_to_leave(bot_id)
            if args.verbose:
                print(f"  Told {bot_name} to leave")
        except Exception as e:
            print(f"ERROR: Failed to tell {bot_name} to leave: {e}", file=sys.stderr)

    # 5) Wait for all bots to end
    if args.verbose:
        print(f"\nWaiting for all {len(bots)} bots to end...")

    def _pred_ended(state: str, bot_obj: Dict) -> bool:
        return (state or "").strip().lower() == "ended"

    for bot_id, bot_name in bots:
        try:
            wait_for_state(client, bot_id, _pred_ended, "ended", args.end_timeout)
            if args.verbose:
                print(f"  {bot_name} ended")
        except TimeoutError as e:
            print(f"WARNING: {bot_name} did not end cleanly: {e}", file=sys.stderr)

    if args.verbose:
        print("\n✓ Stress test completed successfully!")

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)

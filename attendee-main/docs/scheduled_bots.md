# Scheduled Bots

Scheduled bots allow you to have your bot join a meeting at a specific time in the future.

## Why Use Scheduled Bots?

- **Ensure punctual joining**: When creating an ad-hoc bot there is a slight delay because of the need to allocate resources. Scheduled bots join at exactly the specified time, because the resources are allocated in advance.
- **Avoid having to writing your own job scheduler for launching bots**: We handle the scheduling for you
- **Integrate with calendar systems**: Perfect for joining meetings at scheduled calendar event times

## Creating a Scheduled Bot

To create a scheduled bot, include the `join_at` parameter when making your bot creation API call:

```json
{
  "meeting_url": "https://zoom.us/j/123456789",
  "bot_name": "My scheduled bot",
  "join_at": "2025-06-16T16:24:00+0000",
}
```

The response will include:

```json
{
  "id":"bot_HiXYgjyeWmTVOaII",
  "meeting_url":"https://meet.google.com/gvy-zzra-ktd",
  "state":"scheduled",
  "join_at":"2025-06-16T16:55:00Z"
}
```

### Requirements for the `join_at` field

- **Cannot be in the past**: The `join_at` time must be in the future
- **Minimum lead time**: Ideally set `join_at` at least 2 minutes in the future to allow sufficient time to spin up the resources for the bot
- **Format**: Use ISO 8601 format (e.g., `2024-01-15T10:30:00Z`)

## Bot State Lifecycle

Scheduled bots follow a different state progression than ad-hoc bots:

### 1. Scheduled State
- **When**: Initial state when a bot is created with a `join_at` time
- **What happens**: The bot is queued and waiting until it's time to allocate resources for the bot
- **Duration**: Until resources are allocated (a few minutes before `join_at`)

### 2. Staged State  
- **When**: Resources have been allocated and the bot is ready to join
- **What happens**: The bot resources are allocated and the bot is waiting for the exact join time
- **Duration**: Until the `join_at` time

### 3. Joining State
- **When**: At the specified `join_at` time
- **What happens**: The bot actively attempts to join the meeting
- **Duration**: Until the bot successfully joins or encounters an error

### 4. Subsequent States
After joining, the bot follows the normal state progression (joined, recording, etc.).

## Managing Scheduled Bots

You can reschedule or cancel scheduled bots while they are in the `scheduled` state.

### Rescheduling a Scheduled Bot

To change the join time of a scheduled bot, use the PATCH endpoint:

**Request:**
```
PATCH /bots/{bot_id}
```

```json
{
  "join_at": "2025-06-16T17:00:00Z"
}
```

**Response:**
```json
{
  "id":"bot_HiXYgjyeWmTVOaII",
  "meeting_url":"https://meet.google.com/gvy-zzra-ktd",
  "state":"scheduled",
  "join_at":"2025-06-16T17:00:00Z"
}
```

**Requirements:**
- Bot must be in `scheduled` state
- New `join_at` time cannot be in the past
- Uses the same validation rules as when creating a scheduled bot

### Unscheduling (Deleting) a Scheduled Bot

To cancel a scheduled bot before it joins, use the DELETE endpoint:

**Request:**
```
DELETE /bots/{bot_id}
```

**Response:**
```
200 OK
```

**Requirements:**
- Bot must be in `scheduled` state
- Once deleted, the bot cannot be recovered
- This operation only works for scheduled bots that haven't started joining yet
import asyncio
from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.exceptions import ApplicationError

TASK_QUEUE = "events"
ACTIVITY_OPTS = dict(start_to_close_timeout=timedelta(seconds=30))
MAX_SEATS_PER_BOOKING = 4


@dataclass
class Reservation:
    user: str
    seats: list[str]


@dataclass
class Booking:
    booking_id: str
    seats: list[str]
    hold_id: str


@activity.defn
async def place_payment_hold(user: str, seats: list[str]) -> str:
    # In production: pre-authorise the card, passing an idempotency key to the provider.
    if user == "declined":
        raise ApplicationError("payment hold declined", type="HoldDeclined", non_retryable=True)
    await asyncio.sleep(0.2)  # the slow external call that makes races possible
    return f"hold-{user}-{'-'.join(seats)}"


@workflow.defn
class EventWorkflow:
    @workflow.init
    def __init__(self, seats: list[str]) -> None:
        self.owner: dict[str, str] = {s: "" for s in seats}  # "" means free (dict: deterministic order)
        self.lock = asyncio.Lock()
        self.sales_closed = False

    @workflow.update
    async def reserve(self, r: Reservation) -> Booking:
        async with self.lock:  # one reservation at a time
            # AUTHORITATIVE check. The validator below ran earlier and can be stale by now.
            taken = [s for s in r.seats if self.owner[s] != ""]
            if taken:
                raise ApplicationError(
                    f"seats already taken: {', '.join(taken)}", type="SeatTaken", non_retryable=True
                )
            hold_id = await workflow.execute_activity(
                place_payment_hold, args=[r.user, r.seats], **ACTIVITY_OPTS
            )
            for s in r.seats:  # only mark seats once the money side succeeded
                self.owner[s] = r.user
            return Booking(booking_id=f"bk-{hold_id}", seats=r.seats, hold_id=hold_id)

    @reserve.validator
    def validate_reserve(self, r: Reservation) -> None:
        # Cheap, fast rejection. Never the only line of defence.
        if self.sales_closed:
            raise ValueError("sales are closed")
        if not r.seats or len(r.seats) > MAX_SEATS_PER_BOOKING:
            raise ValueError(f"choose 1 to {MAX_SEATS_PER_BOOKING} seats")
        unknown = [s for s in r.seats if s not in self.owner]
        if unknown:
            raise ValueError(f"unknown seats: {', '.join(unknown)}")

    @workflow.signal
    def close_sales(self) -> None:
        self.sales_closed = True

    @workflow.run
    async def run(self, seats: list[str]) -> dict[str, str]:
        await workflow.wait_condition(lambda: self.sales_closed)
        await workflow.wait_condition(workflow.all_handlers_finished)  # let in-flight reservations finish
        return {s: u for s, u in self.owner.items() if u}

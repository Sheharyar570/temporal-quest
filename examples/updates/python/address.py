from dataclasses import dataclass

from temporalio import workflow

TASK_QUEUE = "orders"
ETA_DAYS = {"DE": 2, "US": 5}  # everything else: 9 days


@dataclass
class Address:
    street: str
    city: str
    postal_code: str
    country: str


@dataclass
class AddressChange:
    address: Address
    eta_days: int


def eta_days(a: Address) -> int:
    return ETA_DAYS.get(a.country, 9)


@workflow.defn
class OrderWorkflow:
    @workflow.init
    def __init__(self, order_id: str, address: Address) -> None:
        # Initialise state HERE, not at the top of run(): an update that arrives with the start
        # request can be handled before run() executes its first line.
        self.address = address
        self.status = "processing"  # processing -> shipped -> delivered

    @workflow.run
    async def run(self, order_id: str, address: Address) -> str:
        await workflow.wait_condition(lambda: self.status == "delivered")
        return f"{order_id} delivered to {self.address.city}"

    @workflow.signal
    def mark_shipped(self) -> None:
        self.status = "shipped"

    @workflow.signal
    def mark_delivered(self) -> None:
        self.status = "delivered"

    @workflow.query
    def get_status(self) -> str:
        return self.status

    @workflow.update
    def change_address(self, new: Address) -> AddressChange:
        self.address = new
        return AddressChange(new, eta_days(new))  # the caller gets a real answer

    @change_address.validator
    def validate_change_address(self, new: Address) -> None:
        # Runs BEFORE the update is accepted. Raise to reject: nothing is written to history.
        if self.status != "processing":
            raise ValueError("order already shipped, address can no longer change")
        if not new.street.strip():
            raise ValueError("street is required")
        if new.country in ("DE", "US") and not (new.postal_code.isdigit() and len(new.postal_code) == 5):
            raise ValueError("postal code must be 5 digits")

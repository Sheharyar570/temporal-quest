"""Use case 3 (Hard): a nightly import that fans out to child workflows and keeps its history bounded with Continue-As-New."""
import asyncio
from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow

TASK_QUEUE = "imports"
TOTAL_RECORDS = 100
PAGE_SIZE = 10
DONE: list[int] = []  # page numbers processed (stand-in for rows written)


@activity.defn
async def import_page(page: int, delay: float) -> int:
    await asyncio.sleep(delay)
    DONE.append(page)
    return PAGE_SIZE


@dataclass
class PageInput:
    page: int
    delay: float = 0.0


@workflow.defn
class PageWorkflow:
    @workflow.run
    async def run(self, p: PageInput) -> int:
        return await workflow.execute_activity(import_page, args=[p.page, p.delay], start_to_close_timeout=timedelta(seconds=30))


@dataclass
class ImportInput:
    job: str
    next_page: int = 0
    imported: int = 0  # carried across runs
    pages_per_run: int = 4  # small on purpose so the test sees several runs
    page_delay: float = 0.0
    parent_close: str = "TERMINATE"  # or ABANDON / REQUEST_CANCEL


@workflow.defn
class ImportWorkflow:
    @workflow.run
    async def run(self, inp: ImportInput) -> int:
        policy = workflow.ParentClosePolicy[inp.parent_close]
        last_page = TOTAL_RECORDS // PAGE_SIZE
        done_this_run = 0
        while inp.next_page < last_page:
            # 2 children at a time; deterministic child IDs, so a replayed or repeated start cannot create a duplicate
            batch = range(inp.next_page, min(inp.next_page + 2, last_page))
            counts = await asyncio.gather(*[
                workflow.execute_child_workflow(
                    PageWorkflow.run, PageInput(p, inp.page_delay),
                    id=f"{inp.job}-page-{p}", parent_close_policy=policy)
                for p in batch])
            inp.imported += sum(counts)
            inp.next_page += len(batch)
            done_this_run += len(batch)
            # continue when the server says history is getting big (or, here, after a fixed number of pages)
            if inp.next_page < last_page and (workflow.info().is_continue_as_new_suggested() or done_this_run >= inp.pages_per_run):
                workflow.continue_as_new(inp)
        return inp.imported

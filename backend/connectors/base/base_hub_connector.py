"""
Base Hub Connector: Abstract base class for all hub/aggregator connectors.
Provides common functionality for connectors that aggregate other connectors.
"""

from typing import Generator, Dict, Any, List, Tuple, Optional
from queue import Queue
from threading import Thread
from concurrent.futures import ThreadPoolExecutor, as_completed

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("base_hub_connector")


class BaseHubConnector(BaseConnector):
    """
    Abstract base class for hub/aggregator connectors.

    Hub connectors aggregate multiple child connectors and stream their results.
    They don't have their own data, but orchestrate parallel processing of children.

    Two parallel processing strategies are supported:
    1. Queue-based streaming (for smaller number of children, real-time streaming)
    2. ThreadPoolExecutor with futures (for larger number of children, better resource management)
    """
    
    # Hub connectors don't produce raw data themselves
    is_hub_connector = True

    def __init__(
        self,
        child_connectors: List[Tuple[str, BaseConnector]],
        parallel_strategy: str = "queue",  # "queue" or "futures"
        account_id: Optional[int] = None,
        connector_id: Optional[int] = None,
        config: Optional[Dict[str, Any]] = None,
        progress_callback: Optional[Any] = None,
        abort_event: Optional[Any] = None,
    ):
        """
        Initialize the hub connector.

        Args:
            child_connectors: List of (connector_name, connector_instance) tuples
            parallel_strategy: "queue" for streaming or "futures" for batch processing
            account_id: The Account ID this connector belongs to
            connector_id: The AccountConnector ID for this specific connector
            config: Connector configuration dict (includes parent_output_path)
            progress_callback: Optional callback for progress reporting
            abort_event: Optional threading.Event for abort signaling

        Note: Test mode is determined by the TEST_MODE environment variable.
        """
        self.child_connectors = child_connectors
        self.parallel_strategy = parallel_strategy

        super().__init__(
            account_id=account_id,
            connector_id=connector_id,
            config=config,
            progress_callback=progress_callback,
            abort_event=abort_event,
        )

    def get_test_data_path(self) -> str:
        """
        Hub connectors don't have their own test data.
        They delegate to child connectors who define their own paths.
        """
        return None

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Fetch raw data from all child connectors in parallel with streaming.

        Uses the configured parallel strategy (queue-based or futures-based).
        Items are yielded immediately as they arrive from child connectors,
        enabling incremental processing without waiting for all data.

        Yields:
            Wrapped raw items with connector metadata
        """
        if not self.child_connectors:
            log.warning(f"⚠️ [{self.connector_name}] No child connectors available")
            return

        log.info(
            f"🚀 [{self.connector_name}] Starting to fetch from {len(self.child_connectors)} child connector(s) "
            f"using {self.parallel_strategy} strategy"
        )

        if self.parallel_strategy == "queue":
            yield from self._parallel_queue_strategy(self.child_connectors)
        elif self.parallel_strategy == "futures":
            yield from self._parallel_futures_strategy(self.child_connectors)
        else:
            raise ValueError(f"Unknown parallel strategy: {self.parallel_strategy}")

    def _parallel_queue_strategy(
        self, child_connectors: List[Tuple[str, BaseConnector]]
    ) -> Generator[Dict[str, Any], None, None]:
        """
        Process child connectors using queue-based streaming.
        Best for smaller number of children with real-time streaming needs.
        """
        queue = Queue()

        def fetch_and_queue(connector_name: str, connector: BaseConnector):
            """Fetch from connector and put each item in queue as it arrives."""
            try:
                log.info(f"   🔗 [{connector.connector_name}] Started fetching")
                item_count = 0

                for raw_item, normalized_item, error in connector.yield_normalized():
                    wrapped_raw = {
                        "connector_name": connector.connector_name,
                        "_connector_id": connector.connector_id,
                        "_master_source": connector.connector_name,
                        "raw_item": raw_item,
                        "normalized_item": normalized_item,
                        "error": error,
                    }
                    queue.put(wrapped_raw)
                    item_count += 1

                log.info(
                    f"   ✅ [{connector.connector_name}] Completed fetching ({item_count} items)"
                )
            except Exception as e:
                import traceback

                log.error(f"   ❌ [{connector.connector_name}] Error: {e}")
                log.error(
                    f"   ❌ [{connector.connector_name}] Traceback: {traceback.format_exc()}"
                )
                queue.put(
                    {
                        "connector_name": connector.connector_name,
                        "_connector_id": connector.connector_id,
                        "_master_source": connector.connector_name,
                        "raw_item": {"error_type": "connector_failure"},
                        "normalized_item": None,
                        "error": f"{connector.connector_name} error: {str(e)}",
                    }
                )
            finally:
                queue.put(None)  # Signal this connector is done

        # Start all child connectors in parallel threads
        threads = []
        for connector_name, connector in child_connectors:
            thread = Thread(
                target=fetch_and_queue,
                args=(connector_name, connector),
                daemon=True,
            )
            threads.append(thread)
            thread.start()

        # Yield items as they arrive from any connector
        completed_connectors = 0
        total_connectors = len(threads)

        while completed_connectors < total_connectors:
            try:
                # Use timeout to detect potential hangs (5 minutes for slow API fetching)
                item = queue.get(timeout=900)
                if item is None:
                    completed_connectors += 1
                    log.info(
                        f"   📊 Progress: {completed_connectors}/{total_connectors} connectors completed"
                    )
                else:
                    yield item
            except Exception as e:
                # Timeout or other error - check thread status
                alive_threads = [t for t in threads if t.is_alive()]
                log.error(
                    f"   ⚠️ Queue timeout waiting for connectors. "
                    f"{len(alive_threads)}/{len(threads)} threads still alive. "
                    f"Completed: {completed_connectors}/{total_connectors}"
                )
                # Continue waiting, but log which threads might be stuck
                for idx, t in enumerate(threads):
                    status = "alive" if t.is_alive() else "done"
                    connector_name = (
                        child_connectors[idx][0]
                        if idx < len(child_connectors)
                        else "unknown"
                    )
                    log.error(f"      Thread {idx} ({connector_name}): {status}")

        # Wait for all threads to finish
        for thread in threads:
            thread.join()

        log.info(
            f"✅ [{self.connector_name}] Completed fetching from all {total_connectors} child connector(s)"
        )

    def _parallel_futures_strategy(
        self, child_connectors: List[Tuple[str, BaseConnector]]
    ) -> Generator[Dict[str, Any], None, None]:
        """
        Process child connectors using ThreadPoolExecutor with futures.
        Best for larger number of children with better resource management.
        """

        def process_connector(connector_name: str, connector: BaseConnector):
            """Process a single connector and return all its results."""
            results = []
            try:
                log.info(f"🔄 [{connector.connector_name}] Processing...")

                trade_count = 0
                error_count = 0

                for raw_item, normalized_item, error in connector.yield_normalized():
                    wrapped_raw = {
                        "connector_name": connector.connector_name,
                        "_connector_id": connector.connector_id,
                        "_master_source": connector.connector_name,
                        "raw_item": raw_item,
                        "normalized_item": normalized_item,
                        "error": error,
                    }

                    if error:
                        error_count += 1
                    else:
                        trade_count += 1

                    results.append(wrapped_raw)

                log.info(
                    f"✅ [{connector.connector_name}] {trade_count} items, {error_count} errors"
                )

            except Exception as e:
                log.error(f"❌ [{connector.connector_name}] Error: {e}")
                results.append(
                    {
                        "connector_name": connector.connector_name,
                        "_connector_id": connector.connector_id,
                        "_master_source": connector.connector_name,
                        "raw_item": {"error_type": "connector_failure"},
                        "normalized_item": None,
                        "error": f"{connector.connector_name} failed: {str(e)}",
                    }
                )

            return results

        # Process all connectors in parallel with limited workers
        max_workers = min(len(child_connectors), 3)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            # Submit all connector tasks
            futures = {
                executor.submit(process_connector, name, conn): name
                for name, conn in child_connectors
            }

            # Collect results as they complete
            for future in as_completed(futures):
                connector_name = futures[future]
                try:
                    results = future.result()
                    # Yield all results from this connector
                    for wrapped_raw in results:
                        yield wrapped_raw

                except Exception as e:
                    log.error(f"❌ Future failed for {connector_name}: {e}")
                    yield {
                        "connector_name": connector_name,
                        "_connector_id": None,
                        "_master_source": connector_name,
                        "raw_item": {"error_type": "future_failure"},
                        "normalized_item": None,
                        "error": f"Future failed for {connector_name}: {str(e)}",
                    }

    def raw_to_normalized(self, raw_item: Dict[str, Any]) -> "NormalizedTransaction":
        """
        Transform a wrapped raw item to normalized format.

        Since child connectors already normalize their data, this unwraps
        and adds hub-level metadata.

        Args:
            raw_item: Wrapped raw item containing connector metadata

        Returns:
            Normalized item with hub metadata added
        """
        connector_name = raw_item.get("connector_name")
        normalized_item = raw_item.get("normalized_item")
        error = raw_item.get("error")

        # If there's an error, raise it so the base class can handle it
        if error:
            raise ValueError(error)

        # If there's already a normalized item from child connector, use it
        if normalized_item:
            # All connectors should return NormalizedTransaction dataclass
            # Hub metadata can be stored in tags if needed
            return normalized_item

        # This shouldn't happen, but handle gracefully
        raise ValueError(f"No normalized data available for {connector_name}")

    def cleanup(self):
        """
        Cleanup hub resources and all child connectors.
        
        This calls cleanup() on each child connector, which allows
        file-based connectors to delete their processed files.
        """
        # Cleanup all child connectors first
        for connector_name, connector in self.child_connectors:
            try:
                connector.cleanup()
                log.info(f"🧹 [{connector_name}] Cleaned up")
            except Exception as e:
                log.error(f"❌ [{connector_name}] Cleanup failed: {e}")
        
        # Call parent cleanup for hub's own resources
        super().cleanup()

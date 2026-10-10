"""Warehouse's synchronous, standard-library-only backend client."""
from .client import IngestionFailed, WarehouseClient, WarehouseError, WarehouseTransportError

__all__ = ["WarehouseClient", "WarehouseError", "WarehouseTransportError", "IngestionFailed"]
__version__ = "0.1.0"

"""zbucket's synchronous, standard-library-only backend client."""
from .client import IngestionFailed, ZbucketClient, ZbucketError, ZbucketTransportError

WarehouseClient = ZbucketClient
WarehouseError = ZbucketError
WarehouseTransportError = ZbucketTransportError
__all__ = ["ZbucketClient", "ZbucketError", "ZbucketTransportError", "IngestionFailed",
           "WarehouseClient", "WarehouseError", "WarehouseTransportError"]
__version__ = "0.1.0"

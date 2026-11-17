"""Compatibility imports. New applications should import shpyrd_zbucket."""
import sys
from shpyrd_zbucket import (
    IngestionFailed, ZbucketClient, ZbucketError, ZbucketTransportError,
    WarehouseClient, WarehouseError, WarehouseTransportError, __version__,
)
from shpyrd_zbucket import client

# Preserve imports and instrumentation targeting shpyrd_warehouse.client.
sys.modules[__name__ + ".client"] = client
__all__ = ["ZbucketClient", "ZbucketError", "ZbucketTransportError", "IngestionFailed",
           "WarehouseClient", "WarehouseError", "WarehouseTransportError"]

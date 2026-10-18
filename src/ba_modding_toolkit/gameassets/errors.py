"""Asset lookup failures."""


class AssetNotFound(KeyError):
    """An atlas, sprite, texture, prefab, subtree or Spine core is unknown."""

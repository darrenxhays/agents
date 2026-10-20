from dataclasses import dataclass

from shop.textutil import truncate


@dataclass
class Product:
    name: str
    price_cents: int

    def teaser(self):
        return truncate(self.name, 20)

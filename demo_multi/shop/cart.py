from shop.catalog import get_product
from shop.discount import coupon_off_cents
from shop.tax import tax_cents


class Cart:
    def __init__(self) -> None:
        self._lines: list[tuple[str, int]] = []

    def add(self, sku: str, qty: int = 1) -> None:
        get_product(sku)
        if qty <= 0:
            raise ValueError("qty must be positive")
        self._lines.append((sku, qty))

    def subtotal_cents(self) -> int:
        total = 0
        for sku, qty in self._lines:
            total += get_product(sku)["price_cents"]
        return total

    def total_cents(self) -> int:
        net = self.subtotal_cents() - coupon_off_cents(self.subtotal_cents())
        return net + tax_cents(net)

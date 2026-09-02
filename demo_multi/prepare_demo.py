"""把 demo_multi 还原成测试失败的状态，便于录演示视频。"""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent

CATALOG = '''PRODUCTS = {
    "A100": {"name": "notebook", "price_cents": 10000, "stock": 3},
    "B200": {"name": "mouse", "price_cents": 2000, "stock": 2},
}


def get_product(sku: str) -> dict:
    if sku not in PRODUCTS:
        raise KeyError(sku)
    return PRODUCTS[sku]
'''

CART = '''from shop.catalog import get_product
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
'''

DISCOUNT = '''def coupon_off_cents(subtotal_cents: int) -> int:
    """满减尚未实现。演示开始时应失败，由 agent 接上已有档位表。"""
    return 0
'''

TAX = '''def tax_cents(net_cents: int) -> int:
    """未实现。演示开始时应失败，由 agent 补 6% 税（向下取整到分）。"""
    return 0
'''


def main() -> None:
    (HERE / "shop" / "catalog.py").write_text(CATALOG, encoding="utf-8")
    (HERE / "shop" / "cart.py").write_text(CART, encoding="utf-8")
    (HERE / "shop" / "discount.py").write_text(DISCOUNT, encoding="utf-8")
    (HERE / "shop" / "tax.py").write_text(TAX, encoding="utf-8")
    print("已还原演示缺陷：小计未乘数量、满减恒为 0、未校验库存、税为 0。")
    print("请运行: python -m pytest")
    print("预期：7 项里约 5 项失败（未知 SKU、加到库存上限应仍通过）。")


if __name__ == "__main__":
    main()

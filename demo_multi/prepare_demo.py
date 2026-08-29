"""把 demo_multi 还原成测试失败的状态，便于录演示视频。"""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent

CART = '''from shop.catalog import get_product
from shop.discount import coupon_off_cents


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
        return self.subtotal_cents() - coupon_off_cents(self.subtotal_cents())
'''

DISCOUNT = '''def coupon_off_cents(subtotal_cents: int) -> int:
    """满减尚未实现。演示开始时应失败，由 agent 补上档位。"""
    return 0
'''


def main() -> None:
    (HERE / "shop" / "cart.py").write_text(CART, encoding="utf-8")
    (HERE / "shop" / "discount.py").write_text(DISCOUNT, encoding="utf-8")
    print("已还原演示缺陷：小计未乘数量、满减恒为 0。")
    print("请运行: python -m pytest")
    print("预期：test_subtotal_two_items / test_coupon_tiers / test_checkout_total 失败。")


if __name__ == "__main__":
    main()

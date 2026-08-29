"""满减档位规则。

金额单位是分。满减取最高一档且不可叠加。
"""

# 每个档位：(门槛金额, 减免金额)，按门槛从高到低排列。
COUPON_TIERS = [
    (10000, 1500),  # 满 100 元减 15 元
    (5000, 500),    # 满 50 元减 5 元
]


def coupon_off_cents(subtotal_cents: int) -> int:
    """根据小计金额计算满减金额，取满足条件的最高一档。"""
    for threshold, off in COUPON_TIERS:
        if subtotal_cents >= threshold:
            return off
    return 0

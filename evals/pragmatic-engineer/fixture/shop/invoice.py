from dataclasses import dataclass, field


@dataclass
class Line:
    description: str
    unit_price: float
    quantity: int

    def amount(self):
        return self.unit_price * self.quantity


@dataclass
class Invoice:
    lines: list = field(default_factory=list)

    def add(self, description, unit_price, quantity=1):
        self.lines.append(Line(description, unit_price, quantity))

    def total(self):
        return sum(line.amount() for line in self.lines)

    def render(self):
        rows = [f"{l.description}: {l.amount():.2f}" for l in self.lines]
        rows.append(f"Total: {self.total():.2f}")
        return "\n".join(rows)

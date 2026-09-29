import torch
import torch.nn as nn


class TemporalModel(nn.Module):
    """
    LSTM-based temporal model for predictive maintenance.

    Input:
        (batch_size, sequence_length, num_features)

    Output:
        (batch_size,) for the original scalar model, or
        (batch_size, output_size) for multiple event scores.
    """

    def __init__(
            self,
            input_size,
            hidden_size=128,
            num_layers=2,
            dropout=0.2,
            output_size=1,
    ):
        super().__init__()
        if output_size < 1:
            raise ValueError("output_size must be positive")
        self.output_size = output_size

        self.lstm = nn.LSTM(
            input_size=input_size,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=dropout if num_layers > 1 else 0,
        )

        self.fc = nn.Sequential(
            nn.Linear(hidden_size, 64),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(64, output_size),
        )

    def forward(self, x):
        """
        x shape:

            (batch, sequence_length, features)

        """

        # LSTM processes the entire sequence.
        output, (hidden, cell) = self.lstm(x)

        # Take the output from the LAST timestep.
        last_output = output[:, -1, :]

        # Map the sequence representation to prediction scores.
        prediction = self.fc(last_output)

        return prediction.squeeze(1) if self.output_size == 1 else prediction


# ============================================================
# TEST
# ============================================================

if __name__ == "__main__":

    # Fake example:
    #
    # 32 training examples
    # 50 historical cycles
    # 14 sensor features
    #

    batch_size = 32
    sequence_length = 50
    num_features = 14

    model = TemporalModel(
        input_size=num_features
    )

    x = torch.randn(
        batch_size,
        sequence_length,
        num_features
    )

    output = model(x)

    print("Input shape:")
    print(x.shape)

    print("\nOutput shape:")
    print(output.shape)

    print("\nExample predictions:")
    print(output[:5])

    print("\nModel:")
    print(model)

export type NotificationAction =
  | "accept"
  | "view"
  | "snooze"
  | "dismiss"
  | "timeout";

export interface AlerterResponse {
  activationType: string;
  activationValue?: string;
  deliveredAt: string;
}

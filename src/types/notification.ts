export type NotificationAction =
  | "accept"
  | "view"
  | "snooze"
  | "dismiss"
  | "timeout"
  | "notified";

export interface AlerterResponse {
  activationType: string;
  activationValue?: string;
  deliveredAt: string;
}

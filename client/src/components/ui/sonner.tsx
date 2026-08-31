import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="top-left"
      dir="rtl"
      closeButton
      expand
      offset={{ top: 24, left: 24 }}
      mobileOffset={{ top: 12, left: 12, right: 12 }}
      style={
        {
          "--normal-bg": "#ffffff",
          "--normal-text": "#173f38",
          "--normal-border": "#d8e6dc",
          zIndex: 100,
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
